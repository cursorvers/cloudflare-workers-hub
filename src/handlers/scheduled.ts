/**
 * Scheduled Handler for Cron Triggers
 *
 * Dispatches to the appropriate handler based on cron expression:
 * - "0 * * * *"    → Hourly Limitless.ai sync (backup)
 * - "0 21 * * *"   → Daily action item check (6AM JST)
 * - "0 0 * * SUN"  → Weekly digest generation (Sunday 9AM JST)
 * - "0 0 1 * *"    → Monthly digest generation (1st of month, 9AM JST)
 * - "0 0 2 1 *"    → Annual digest generation (Jan 2nd, 9AM JST)
 */

import { Env } from '../types';
import { safeLog } from '../utils/log-sanitizer';
import { syncToSupabase } from '../services/limitless';
import { supabaseSelect, supabaseUpsert, type SupabaseConfig } from '../services/supabase-client';
import {
  aggregateWeeklyDigest,
  aggregateActionItems,
  generateWeeklyMarkdown,
  generateMonthlyMarkdown,
  generateAnnualMarkdown,
  generateActionItemsMarkdown,
  type LifelogRecord,
} from '../services/digest-generator';
import { sendDiscordNotification, type Notification } from './notifications';
import { handleDaemonHealthCheck } from './daemon-monitor';

// ============================================================================
// Constants
// ============================================================================

/** JST offset in milliseconds (UTC+9) */
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

// ============================================================================
// Cron Expression Constants
// ============================================================================

const CRON_HOURLY_SYNC = '0 * * * *';
const CRON_DAILY_ACTIONS = '0 21 * * *';   // 21:00 UTC = 06:00 JST
const CRON_WEEKLY_DIGEST = '0 0 * * SUN';  // Sun 00:00 UTC = Sun 09:00 JST
const CRON_MONTHLY_DIGEST = '0 0 1 * *';  // 1st 00:00 UTC = 1st 09:00 JST
const CRON_ANNUAL_DIGEST = '0 0 2 1 *';   // Jan 2nd 00:00 UTC = Jan 2nd 09:00 JST

// ============================================================================
// Distributed Lock Helpers
// ============================================================================

/**
 * Acquire distributed lock using KV compare-and-swap
 * @returns true if lock acquired, false if already held
 */
async function acquireLock(kv: KVNamespace, lockKey: string, ttlSeconds: number): Promise<boolean> {
  const lockValue = Date.now().toString();
  const metadata = { acquiredAt: Date.now() };

  try {
    await kv.put(lockKey, lockValue, {
      expirationTtl: ttlSeconds,
      metadata,
    });
    const verifyValue = await kv.get(lockKey);
    return verifyValue === lockValue;
  } catch {
    return false;
  }
}

/**
 * Release distributed lock
 */
async function releaseLock(kv: KVNamespace, lockKey: string): Promise<void> {
  try {
    await kv.delete(lockKey);
  } catch (error) {
    safeLog.warn('[Lock] Failed to release lock', {
      lockKey,
      error: String(error),
    });
  }
}

/**
 * Run a handler with an independent distributed lock.
 * Soft-fail: logs errors but never throws.
 */
async function withLock(
  kv: KVNamespace,
  lockKey: string,
  ttlSeconds: number,
  handler: () => Promise<void>
): Promise<void> {
  const acquired = await acquireLock(kv, lockKey, ttlSeconds);
  if (!acquired) {
    safeLog.info('[Scheduled] Lock held, skipping', { lockKey });
    return;
  }
  try {
    await handler();
  } catch (error) {
    safeLog.error('[Scheduled] Handler failed', { lockKey, error: String(error) });
  } finally {
    await releaseLock(kv, lockKey);
  }
}

// ============================================================================
// Main Dispatcher
// ============================================================================

/**
 * Handle scheduled events from Cloudflare Workers Cron.
 * Dispatches to the appropriate handler based on the cron expression.
 */
export async function handleScheduled(
  controller: ScheduledController,
  env: Env,
  ctx: ExecutionContext
): Promise<void> {
  const scheduledTime = new Date(controller.scheduledTime);

  safeLog.info('[Scheduled] Cron trigger fired', {
    scheduledTime: scheduledTime.toISOString(),
    cron: controller.cron,
  });

  if (!env.CACHE) {
    safeLog.warn('[Scheduled] CACHE KV not configured, cannot use distributed locking');
    return;
  }

  switch (controller.cron) {
    case CRON_HOURLY_SYNC:
      // Run both tasks independently with separate locks
      await Promise.all([
        handleLimitlessSync(env),
        handleDaemonHealthCheck(env, withLock),
      ]);
      return;

    case CRON_DAILY_ACTIONS:
      return handleDailyActionCheck(env);

    case CRON_WEEKLY_DIGEST:
      return handleWeeklyDigest(env);

    case CRON_MONTHLY_DIGEST:
      return handleMonthlyDigest(env);

    case CRON_ANNUAL_DIGEST:
      return handleAnnualDigest(env);

    default:
      safeLog.warn('[Scheduled] Unknown cron expression', { cron: controller.cron });
  }
}

// ============================================================================
// Handler: Hourly Limitless Sync (existing logic, extracted)
// ============================================================================

async function handleLimitlessSync(env: Env): Promise<void> {
  const lockKey = `limitless:sync_lock:${env.LIMITLESS_USER_ID || 'default'}`;

  await withLock(env.CACHE!, lockKey, 300, async () => {
    const autoSyncEnabled = env.LIMITLESS_AUTO_SYNC_ENABLED === 'true';
    if (!autoSyncEnabled) {
      safeLog.info('[Scheduled] Limitless auto-sync is disabled');
      return;
    }

    if (!env.LIMITLESS_API_KEY) {
      safeLog.warn('[Scheduled] LIMITLESS_API_KEY not configured, skipping sync');
      return;
    }

    if (!env.LIMITLESS_USER_ID) {
      safeLog.warn('[Scheduled] LIMITLESS_USER_ID not configured, skipping sync');
      return;
    }

    const syncIntervalHours = parseInt(env.LIMITLESS_SYNC_INTERVAL_HOURS || '24', 10);

    safeLog.info('[Scheduled] Starting Limitless backup sync', {
      userId: env.LIMITLESS_USER_ID,
      syncIntervalHours,
      purpose: 'catch-up backup (primary sync via iPhone webhook)',
    });

    // Check last backup sync time from KV
    const lastSyncKey = `limitless:backup_sync:${env.LIMITLESS_USER_ID}`;
    const lastSyncData = await env.CACHE!.get(lastSyncKey);

    if (lastSyncData) {
      const lastSync = new Date(lastSyncData);
      const timeDiffMs = Date.now() - lastSync.getTime();

      // Guard: Prevent division by zero and negative time differences
      if (timeDiffMs < 0) {
        safeLog.warn('[Scheduled] Invalid lastSync time (future date), forcing sync', {
          lastSync: lastSync.toISOString(),
        });
      } else {
        const hoursSinceLastSync = timeDiffMs / (1000 * 60 * 60);

        if (hoursSinceLastSync < syncIntervalHours) {
          safeLog.info('[Scheduled] Skipping backup sync (too soon)', {
            lastSync: lastSync.toISOString(),
            hoursSinceLastSync: hoursSinceLastSync.toFixed(2),
            minInterval: syncIntervalHours,
          });
          return;
        }
      }
    }

    const startTime = Date.now();
    const result = await syncToSupabase(env, env.LIMITLESS_API_KEY, {
      userId: env.LIMITLESS_USER_ID,
      maxAgeHours: syncIntervalHours + 2,
      includeAudio: false,
      maxItems: 5,
    });

    const duration = Date.now() - startTime;

    await env.CACHE!.put(lastSyncKey, new Date().toISOString());

    const statsKey = `limitless:backup_stats:${env.LIMITLESS_USER_ID}`;
    const stats = {
      lastSync: new Date().toISOString(),
      synced: result.synced,
      skipped: result.skipped,
      errors: result.errors.length,
      durationMs: duration,
      purpose: 'backup',
    };
    await env.CACHE!.put(statsKey, JSON.stringify(stats));

    safeLog.info('[Scheduled] Limitless backup sync completed', {
      userId: env.LIMITLESS_USER_ID,
      synced: result.synced,
      skipped: result.skipped,
      errors: result.errors.length,
      durationMs: duration,
      note: result.synced > 0 ? 'Caught items missed by iPhone triggers' : 'No new items',
    });

    if (result.errors.length > 0) {
      safeLog.warn('[Scheduled] Sync completed with errors', {
        errors: result.errors.slice(0, 5),
      });
    }
  });
}

// ============================================================================
// Handler: Weekly Digest
// ============================================================================

async function handleWeeklyDigest(env: Env): Promise<void> {
  const lockKey = 'digest:weekly_lock';

  await withLock(env.CACHE!, lockKey, 300, async () => {
    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
      safeLog.warn('[WeeklyDigest] Supabase not configured, skipping');
      return;
    }

    const config: SupabaseConfig = {
      url: env.SUPABASE_URL,
      serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
    };

    // Calculate 7-day range ending yesterday (JST)
    const now = new Date();
    const jstNow = new Date(now.getTime() + JST_OFFSET_MS);
    // Today midnight JST → UTC (use UTC methods to avoid local timezone bug)
    const periodEnd = new Date(
      Date.UTC(jstNow.getUTCFullYear(), jstNow.getUTCMonth(), jstNow.getUTCDate()) - JST_OFFSET_MS
    );
    const periodStart = new Date(periodEnd.getTime() - 7 * 24 * 60 * 60 * 1000);

    const periodStartISO = periodStart.toISOString();
    const periodEndISO = periodEnd.toISOString();
    const periodStartDate = periodStartISO.slice(0, 10);
    const periodEndDate = new Date(periodEnd.getTime() - 1).toISOString().slice(0, 10);

    safeLog.info('[WeeklyDigest] Generating weekly digest', {
      periodStart: periodStartISO,
      periodEnd: periodEndISO,
    });

    // Fetch all lifelogs for the period
    const selectFields = 'id,classification,summary,key_insights,action_items,topics,speakers,sentiment,title,start_time,end_time,duration_seconds,is_starred';
    const query = `select=${selectFields}&start_time=gte.${periodStartISO}&start_time=lt.${periodEndISO}&classification=neq.pending&order=start_time.asc&limit=500`;

    const { data: lifelogs, error } = await supabaseSelect<LifelogRecord>(config, 'processed_lifelogs', query);

    if (error) {
      safeLog.error('[WeeklyDigest] Failed to fetch lifelogs', { error: error.message });
      return;
    }

    if (!lifelogs || lifelogs.length === 0) {
      safeLog.info('[WeeklyDigest] No lifelogs found for period, skipping');
      return;
    }

    safeLog.info('[WeeklyDigest] Aggregating data', { count: lifelogs.length });

    // Aggregate and generate markdown
    const digest = aggregateWeeklyDigest(lifelogs, periodStartDate, periodEndDate);
    const markdown = generateWeeklyMarkdown(digest);

    // Upsert into digest_reports (unique on type + period_start)
    const { error: upsertError } = await supabaseUpsert(
      config,
      'digest_reports',
      {
        type: 'weekly',
        period_start: periodStartISO,
        period_end: periodEndISO,
        content: digest,
        markdown,
        obsidian_synced: false,
      },
      'type,period_start'
    );

    if (upsertError) {
      safeLog.error('[WeeklyDigest] Failed to store digest', { error: upsertError.message });
      return;
    }

    safeLog.info('[WeeklyDigest] Weekly digest generated', {
      recordings: digest.totalRecordings,
      topics: digest.topTopics.length,
      actionItems: digest.allActionItems.length,
      period: `${periodStartDate} ~ ${periodEndDate}`,
    });

    // Send notification
    await sendDigestNotification(env, 'Weekly', {
      recordings: digest.totalRecordings,
      topics: digest.topTopics.length,
      actionItems: digest.allActionItems.length,
      period: `${periodStartDate} ~ ${periodEndDate}`,
    });
  });
}

// ============================================================================
// Handler: Daily Action Item Check
// ============================================================================

async function handleDailyActionCheck(env: Env): Promise<void> {
  const lockKey = 'digest:daily_actions_lock';

  await withLock(env.CACHE!, lockKey, 300, async () => {
    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
      safeLog.warn('[DailyActions] Supabase not configured, skipping');
      return;
    }

    const config: SupabaseConfig = {
      url: env.SUPABASE_URL,
      serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
    };

    // Look back 14 days for unresolved action items
    const lookbackDays = 14;
    const periodEnd = new Date();
    const periodStart = new Date(periodEnd.getTime() - lookbackDays * 24 * 60 * 60 * 1000);

    const periodStartISO = periodStart.toISOString();
    const periodEndISO = periodEnd.toISOString();
    const todayDate = new Date().toISOString().slice(0, 10);

    safeLog.info('[DailyActions] Checking action items', {
      lookbackDays,
      periodStart: periodStartISO,
    });

    // Fetch lifelogs with action items (only those that have non-empty action_items)
    const selectFields = 'id,classification,action_items,topics,start_time';
    const query = `select=${selectFields}&start_time=gte.${periodStartISO}&start_time=lt.${periodEndISO}&classification=neq.pending&classification=neq.casual&order=start_time.desc&limit=200`;

    const { data: lifelogs, error } = await supabaseSelect<LifelogRecord>(config, 'processed_lifelogs', query);

    if (error) {
      safeLog.error('[DailyActions] Failed to fetch lifelogs', { error: error.message });
      return;
    }

    if (!lifelogs || lifelogs.length === 0) {
      safeLog.info('[DailyActions] No lifelogs found, skipping');
      // Heartbeat: check for inactivity (no recordings in 48h)
      await sendInactivityAlert(env);
      return;
    }

    // Aggregate action items
    const report = aggregateActionItems(
      lifelogs,
      periodStartISO.slice(0, 10),
      todayDate
    );

    if (report.totalItems === 0) {
      safeLog.info('[DailyActions] No action items found, skipping');
      return;
    }

    const markdown = generateActionItemsMarkdown(report);

    // Upsert into digest_reports
    const { error: upsertError } = await supabaseUpsert(
      config,
      'digest_reports',
      {
        type: 'daily_actions',
        period_start: periodStartISO,
        period_end: periodEndISO,
        content: report,
        markdown,
        obsidian_synced: false,
      },
      'type,period_start'
    );

    if (upsertError) {
      safeLog.error('[DailyActions] Failed to store report', { error: upsertError.message });
      return;
    }

    safeLog.info('[DailyActions] Action item report generated', {
      totalItems: report.totalItems,
      topicGroups: Object.keys(report.itemsByTopic).length,
    });
  });
}

// ============================================================================
// Handler: Monthly Digest
// ============================================================================

async function handleMonthlyDigest(env: Env): Promise<void> {
  const lockKey = 'digest:monthly_lock';

  await withLock(env.CACHE!, lockKey, 600, async () => {
    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
      safeLog.warn('[MonthlyDigest] Supabase not configured, skipping');
      return;
    }

    const config: SupabaseConfig = {
      url: env.SUPABASE_URL,
      serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
    };

    // Calculate previous calendar month range (JST)
    const now = new Date();
    const jstNow = new Date(now.getTime() + JST_OFFSET_MS);

    // First day of current month in JST → that's the end boundary (use UTC methods)
    const periodEnd = new Date(
      Date.UTC(jstNow.getUTCFullYear(), jstNow.getUTCMonth(), 1) - JST_OFFSET_MS
    );

    // First day of previous month in JST (use UTC methods)
    const periodStart = new Date(
      Date.UTC(jstNow.getUTCFullYear(), jstNow.getUTCMonth() - 1, 1) - JST_OFFSET_MS
    );

    const periodStartISO = periodStart.toISOString();
    const periodEndISO = periodEnd.toISOString();
    const periodStartDate = periodStartISO.slice(0, 10);
    const periodEndDate = new Date(periodEnd.getTime() - 1).toISOString().slice(0, 10);

    safeLog.info('[MonthlyDigest] Generating monthly digest', {
      periodStart: periodStartISO,
      periodEnd: periodEndISO,
    });

    // Fetch all lifelogs for the month
    const selectFields = 'id,classification,summary,key_insights,action_items,topics,speakers,sentiment,title,start_time,end_time,duration_seconds,is_starred';
    const query = `select=${selectFields}&start_time=gte.${periodStartISO}&start_time=lt.${periodEndISO}&classification=neq.pending&order=start_time.asc&limit=2000`;

    const { data: lifelogs, error } = await supabaseSelect<LifelogRecord>(config, 'processed_lifelogs', query);

    if (error) {
      safeLog.error('[MonthlyDigest] Failed to fetch lifelogs', { error: error.message });
      return;
    }

    if (!lifelogs || lifelogs.length === 0) {
      safeLog.info('[MonthlyDigest] No lifelogs found for period, skipping');
      return;
    }

    safeLog.info('[MonthlyDigest] Aggregating data', { count: lifelogs.length });

    // Aggregate and generate markdown
    const digest = aggregateWeeklyDigest(lifelogs, periodStartDate, periodEndDate);
    const markdown = generateMonthlyMarkdown(digest);

    // Upsert into digest_reports
    const { error: upsertError } = await supabaseUpsert(
      config,
      'digest_reports',
      {
        type: 'monthly',
        period_start: periodStartISO,
        period_end: periodEndISO,
        content: digest,
        markdown,
        obsidian_synced: false,
      },
      'type,period_start'
    );

    if (upsertError) {
      safeLog.error('[MonthlyDigest] Failed to store digest', { error: upsertError.message });
      return;
    }

    safeLog.info('[MonthlyDigest] Monthly digest generated', {
      recordings: digest.totalRecordings,
      topics: digest.topTopics.length,
      actionItems: digest.allActionItems.length,
      period: `${periodStartDate} ~ ${periodEndDate}`,
    });

    // Send notification
    await sendDigestNotification(env, 'Monthly', {
      recordings: digest.totalRecordings,
      topics: digest.topTopics.length,
      actionItems: digest.allActionItems.length,
      period: `${periodStartDate} ~ ${periodEndDate}`,
    });
  });
}

// ============================================================================
// Notification Helper (Heartbeat Pattern)
// ============================================================================

/**
 * Send a digest notification to Discord.
 * Non-blocking: failures are logged but never throw.
 */
async function sendDigestNotification(
  env: Env,
  digestType: string,
  stats: { recordings: number; topics: number; actionItems: number; period: string }
): Promise<void> {
  if (!env.DISCORD_WEBHOOK_URL) return;

  const notification: Notification = {
    type: 'success',
    title: `${digestType} Digest Generated`,
    message: `${stats.recordings}件の録音を集計しました (${stats.period})`,
    source: 'cron-digest',
    fields: [
      { name: 'Recordings', value: String(stats.recordings), inline: true },
      { name: 'Topics', value: String(stats.topics), inline: true },
      { name: 'Action Items', value: String(stats.actionItems), inline: true },
    ],
  };

  try {
    await sendDiscordNotification(env.DISCORD_WEBHOOK_URL, notification);
  } catch (error) {
    safeLog.warn('[Notification] Failed to send digest notification', { error: String(error) });
  }
}

/**
 * Send an inactivity alert when no recordings are found for 48+ hours.
 */
async function sendInactivityAlert(env: Env): Promise<void> {
  if (!env.DISCORD_WEBHOOK_URL) return;

  const notification: Notification = {
    type: 'warning',
    title: 'Pendant Inactivity Alert',
    message: '過去48時間に録音が検出されませんでした。Pendantの接続状態を確認してください。',
    source: 'cron-heartbeat',
  };

  try {
    await sendDiscordNotification(env.DISCORD_WEBHOOK_URL, notification);
  } catch (error) {
    safeLog.warn('[Notification] Failed to send inactivity alert', { error: String(error) });
  }
}

// ============================================================================
// Handler: Annual Digest
// ============================================================================

async function handleAnnualDigest(env: Env): Promise<void> {
  const lockKey = 'digest:annual_lock';

  await withLock(env.CACHE!, lockKey, 900, async () => {
    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
      safeLog.warn('[AnnualDigest] Supabase not configured, skipping');
      return;
    }

    const config: SupabaseConfig = {
      url: env.SUPABASE_URL,
      serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
    };

    // Calculate previous calendar year range (JST)
    const now = new Date();
    const jstNow = new Date(now.getTime() + JST_OFFSET_MS);

    // Jan 1st of current year in JST → that's the end boundary (use UTC methods)
    const periodEnd = new Date(
      Date.UTC(jstNow.getUTCFullYear(), 0, 1) - JST_OFFSET_MS
    );

    // Jan 1st of previous year in JST (use UTC methods)
    const periodStart = new Date(
      Date.UTC(jstNow.getUTCFullYear() - 1, 0, 1) - JST_OFFSET_MS
    );

    const periodStartISO = periodStart.toISOString();
    const periodEndISO = periodEnd.toISOString();
    const periodStartDate = periodStartISO.slice(0, 10);
    const periodEndDate = new Date(periodEnd.getTime() - 1).toISOString().slice(0, 10);

    safeLog.info('[AnnualDigest] Generating annual digest', {
      periodStart: periodStartISO,
      periodEnd: periodEndISO,
    });

    // Fetch all lifelogs for the year (higher limit for annual)
    const selectFields = 'id,classification,summary,key_insights,action_items,topics,speakers,sentiment,title,start_time,end_time,duration_seconds,is_starred';
    const query = `select=${selectFields}&start_time=gte.${periodStartISO}&start_time=lt.${periodEndISO}&classification=neq.pending&order=start_time.asc&limit=5000`;

    const { data: lifelogs, error } = await supabaseSelect<LifelogRecord>(config, 'processed_lifelogs', query);

    if (error) {
      safeLog.error('[AnnualDigest] Failed to fetch lifelogs', { error: error.message });
      return;
    }

    if (!lifelogs || lifelogs.length === 0) {
      safeLog.info('[AnnualDigest] No lifelogs found for period, skipping');
      return;
    }

    safeLog.info('[AnnualDigest] Aggregating data', { count: lifelogs.length });

    // Aggregate and generate markdown
    const digest = aggregateWeeklyDigest(lifelogs, periodStartDate, periodEndDate);
    const markdown = generateAnnualMarkdown(digest);

    // Upsert into digest_reports
    const { error: upsertError } = await supabaseUpsert(
      config,
      'digest_reports',
      {
        type: 'annual',
        period_start: periodStartISO,
        period_end: periodEndISO,
        content: digest,
        markdown,
        obsidian_synced: false,
      },
      'type,period_start'
    );

    if (upsertError) {
      safeLog.error('[AnnualDigest] Failed to store digest', { error: upsertError.message });
      return;
    }

    safeLog.info('[AnnualDigest] Annual digest generated', {
      recordings: digest.totalRecordings,
      topics: digest.topTopics.length,
      actionItems: digest.allActionItems.length,
      period: `${periodStartDate} ~ ${periodEndDate}`,
    });

    // Send notification
    await sendDigestNotification(env, 'Annual', {
      recordings: digest.totalRecordings,
      topics: digest.topTopics.length,
      actionItems: digest.allActionItems.length,
      period: `${periodStartDate} ~ ${periodEndDate}`,
    });
  });
}
