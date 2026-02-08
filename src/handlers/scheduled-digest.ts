/**
 * Scheduled Digest Handlers
 *
 * Extracted from scheduled.ts to keep file size under 400 lines.
 * Handles digest generation and action item checks:
 * - Weekly digest
 * - Monthly digest
 * - Annual digest
 * - Daily action item check
 */

import { Env } from '../types';
import { safeLog } from '../utils/log-sanitizer';
import { supabaseSelect, supabaseUpsert, type SupabaseConfig } from '../services/supabase-client';
import {
  aggregateWeeklyDigest,
  aggregateActionItems,
  generateWeeklyMarkdown,
  generateMonthlyMarkdown,
  generateAnnualMarkdown,
  generateActionItemsMarkdown,
  type LifelogRecord,
  type WeeklyDigest,
} from '../services/digest-generator';
import { sendDiscordNotification, type Notification } from './notifications';
import { getAccessToken, type GoogleCredentials } from '../services/google-auth';
import { handleReflectionNotifications } from './scheduled-reflection';
import {
  generateSlidesFromMarkdown,
  formatDigestAsSlideMarkdown,
  formatActionItemsAsSlideMarkdown,
} from '../services/google-slides';

// ============================================================================
// Constants
// ============================================================================

/** JST offset in milliseconds (UTC+9) */
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

// ============================================================================
// Handler: Weekly Digest
// ============================================================================

export async function handleWeeklyDigest(
  env: Env,
  withLock: typeof import('./scheduled').withLock
): Promise<void> {
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

    // Generate Google Slides (optional, non-blocking)
    const slideMarkdown = formatDigestAsSlideMarkdown(
      digest,
      `Weekly Digest: ${periodStartDate}`
    );
    const slidesUrl = await generateSlidesForDigest(
      env, config, 'weekly', `${periodStartDate} ~ ${periodEndDate}`,
      slideMarkdown, `Weekly Digest: ${periodStartDate}`, periodStartISO
    );

    // Send notification
    await sendDigestNotification(env, 'Weekly', {
      recordings: digest.totalRecordings,
      topics: digest.topTopics.length,
      actionItems: digest.allActionItems.length,
      period: `${periodStartDate} ~ ${periodEndDate}`,
      slidesUrl,
    });
  });
}

// ============================================================================
// Handler: Daily Action Item Check
// ============================================================================

export async function handleDailyActionCheck(
  env: Env,
  withLock: typeof import('./scheduled').withLock
): Promise<void> {
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

    // Limitless Phase 5: Send reflection notifications for pending highlights
    // Run independently to avoid blocking action item report
    await handleReflectionNotifications(env, withLock);

    // KV Usage Reminder: Weekly check (Monday only)
    const dayOfWeek = new Date().getDay();
    if (dayOfWeek === 1) {
      await sendKvUsageReminder(env);
    }
  });
}

// ============================================================================
// Handler: KV Usage Reminder (Weekly)
// ============================================================================

async function sendKvUsageReminder(env: Env): Promise<void> {
  const dashboardUrl = 'https://dash.cloudflare.com/?to=/:account/workers/kv/namespaces';

  const notification: Notification = {
    type: 'info',
    title: '📊 Weekly KV Usage Check',
    message: [
      '**Cloudflare KV 使用量を確認してください**',
      '',
      '🔗 [Cloudflare Dashboard](' + dashboardUrl + ')',
      '',
      '**Free プラン制限:**',
      '- Read: 100,000/日',
      '- Put: 1,000/日',
      '',
      '⚠️ **80%超過時はPaid Plan($5/月)移行を検討**',
    ].join('\n'),
    source: 'kv-monitor',
  };

  try {
    if (!env.DISCORD_WEBHOOK_URL) return;
    await sendDiscordNotification(env.DISCORD_WEBHOOK_URL, notification);
    safeLog.info('[KvReminder] Weekly reminder sent');
  } catch (error) {
    safeLog.warn('[KvReminder] Failed to send reminder', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// ============================================================================
// Handler: Monthly Digest
// ============================================================================

export async function handleMonthlyDigest(
  env: Env,
  withLock: typeof import('./scheduled').withLock
): Promise<void> {
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

    // Generate Google Slides (optional, non-blocking)
    const slideMarkdown = formatDigestAsSlideMarkdown(
      digest,
      `Monthly Digest: ${periodStartDate.slice(0, 7)}`
    );
    const slidesUrl = await generateSlidesForDigest(
      env, config, 'monthly', `${periodStartDate} ~ ${periodEndDate}`,
      slideMarkdown, `Monthly Digest: ${periodStartDate.slice(0, 7)}`, periodStartISO
    );

    // Send notification
    await sendDigestNotification(env, 'Monthly', {
      recordings: digest.totalRecordings,
      topics: digest.topTopics.length,
      actionItems: digest.allActionItems.length,
      period: `${periodStartDate} ~ ${periodEndDate}`,
      slidesUrl,
    });
  });
}

// ============================================================================
// Handler: Annual Digest
// ============================================================================

export async function handleAnnualDigest(
  env: Env,
  withLock: typeof import('./scheduled').withLock
): Promise<void> {
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

    // Generate Google Slides (optional, non-blocking)
    const slideMarkdown = formatDigestAsSlideMarkdown(
      digest,
      `Annual Digest: ${periodStartDate.slice(0, 4)}`
    );
    const slidesUrl = await generateSlidesForDigest(
      env, config, 'annual', `${periodStartDate} ~ ${periodEndDate}`,
      slideMarkdown, `Annual Digest: ${periodStartDate.slice(0, 4)}`, periodStartISO
    );

    // Send notification
    await sendDigestNotification(env, 'Annual', {
      recordings: digest.totalRecordings,
      topics: digest.topTopics.length,
      actionItems: digest.allActionItems.length,
      period: `${periodStartDate} ~ ${periodEndDate}`,
      slidesUrl,
    });
  });
}

// ============================================================================
// Slides Generation Helper
// ============================================================================

/**
 * Check if Google Slides auto-generation is configured.
 */
function isSlidesEnabled(env: Env): boolean {
  return (
    env.SLIDES_AUTO_GENERATE === 'true' &&
    !!env.GOOGLE_CLIENT_ID &&
    !!env.GOOGLE_CLIENT_SECRET &&
    !!env.GOOGLE_REFRESH_TOKEN
  );
}

/**
 * Build Google ADC credentials from environment variables (Workers-compatible).
 * Uses refresh_token flow — no file I/O required.
 */
function buildGoogleCredentials(env: Env): GoogleCredentials {
  return {
    type: 'authorized_user' as const,
    client_id: env.GOOGLE_CLIENT_ID!,
    client_secret: env.GOOGLE_CLIENT_SECRET!,
    refresh_token: env.GOOGLE_REFRESH_TOKEN!,
  };
}

/**
 * Generate Google Slides from a digest and store the URL in Supabase.
 * Non-blocking: failures are logged but never throw.
 *
 * @returns The Slides URL if successful, undefined otherwise
 */
async function generateSlidesForDigest(
  env: Env,
  config: SupabaseConfig,
  digestType: string,
  periodLabel: string,
  markdown: string,
  title: string,
  reportPeriodStart: string
): Promise<string | undefined> {
  if (!isSlidesEnabled(env)) return undefined;

  try {
    const credentials = buildGoogleCredentials(env);
    const { access_token: accessToken } = await getAccessToken(credentials);

    const result = await generateSlidesFromMarkdown({
      markdown,
      title,
      accessToken,
      shareWithEmail: env.GOOGLE_SHARE_EMAIL,
      quotaProject: env.GCP_PROJECT_ID,
    });

    // Store slides_url in digest_reports
    const typeFilter = digestType === 'daily_actions' ? 'daily_actions' : digestType;
    await supabaseUpsert(
      config,
      'digest_reports',
      {
        type: typeFilter,
        period_start: reportPeriodStart,
        slides_url: result.slidesUrl,
      },
      'type,period_start'
    );

    safeLog.info(`[Slides] Generated for ${digestType}`, {
      slidesUrl: result.slidesUrl,
      period: periodLabel,
    });

    return result.slidesUrl;
  } catch (error) {
    safeLog.warn(`[Slides] Failed to generate for ${digestType}`, {
      error: String(error),
      period: periodLabel,
    });
    return undefined;
  }
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
  stats: { recordings: number; topics: number; actionItems: number; period: string; slidesUrl?: string }
): Promise<void> {
  if (!env.DISCORD_WEBHOOK_URL) return;

  const fields = [
    { name: 'Recordings', value: String(stats.recordings), inline: true },
    { name: 'Topics', value: String(stats.topics), inline: true },
    { name: 'Action Items', value: String(stats.actionItems), inline: true },
  ];

  if (stats.slidesUrl) {
    fields.push({ name: 'Slides', value: stats.slidesUrl, inline: false });
  }

  const notification: Notification = {
    type: 'success',
    title: `${digestType} Digest Generated`,
    message: `${stats.recordings}件の録音を集計しました (${stats.period})`,
    source: 'cron-digest',
    fields,
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
