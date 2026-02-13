/**
 * Scheduled Handler for Cron Triggers
 *
 * Dispatches to the appropriate handler based on cron expression:
 * - "0 * * * *"    → Hourly: Gmail polling + Limitless sync + PHI verification (h%6) + subscription cleanup (h==2)
 * - "0 21 * * *"   → Daily action item check (6AM JST)
 * - "0 0 * * SUN"  → Weekly digest generation (Sunday 9AM JST)
 */

import { Env } from '../types';
import { safeLog } from '../utils/log-sanitizer';
import { syncToSupabase } from '../services/limitless';
import { handleDaemonHealthCheck } from './daemon-monitor';
import {
  handleWeeklyDigest,
  handleDailyActionCheck,
  handleMonthlyDigest,
  handleAnnualDigest,
} from './scheduled-digest';
import { handlePhiVerificationCron } from './phi-verification-cron';
import { handleLimitlessPollerCron } from './limitless-poller';
import { handleGmailReceiptPolling } from './receipt-gmail-poller';
import { recordCronRun } from './receipt-backfill';
import { HEALTH } from '../config/confidence-thresholds';
import { recoverPdfReceiptsNeedingFreeeUpload } from './receipt-recovery';
import { backfillReceiptDealLinks } from './receipt-deal-link-backfill';

// ============================================================================
// Cron Expression Constants
// ============================================================================

const CRON_HOURLY = '0 * * * *'; // Hourly: Gmail polling + Limitless sync + time-based sub-jobs
const CRON_QUICK_DEAL_LINK = '*/5 * * * *'; // Temporary: accelerate deal↔receipt link backfill
const CRON_DAILY_ACTIONS = '0 21 * * *';   // 21:00 UTC = 06:00 JST
const CRON_WEEKLY_DIGEST = '0 0 * * SUN';  // Sun 00:00 UTC = Sun 09:00 JST

// Helps confirm which scheduled.ts is running via cron_runs.details.
// (Cloudflare doesn't expose git SHA directly at runtime.)
const SCHEDULED_BUILD_TAG = 'scheduled:deal-link-backfill:v1';

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
  } catch (error) {
    // Fail-open: scheduled automation should keep running even if KV hits limits/outages.
    // We rely on downstream idempotency (e.g., D1 unique constraints) to avoid duplicates.
    safeLog.warn('[Lock] Failed to acquire lock, proceeding without lock', {
      lockKey,
      error: error instanceof Error ? error.message : String(error),
    });
    return true;
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
export async function withLock(
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
  const startTime = Date.now();

  safeLog.info('[Scheduled] Cron trigger fired', {
    scheduledTime: scheduledTime.toISOString(),
    cron: controller.cron,
  });

  // Record cron start to D1 (best-effort diagnostics)
  await recordCronRun(env, `cron:${controller.cron}`, 'success', {
    event: 'started',
    scheduledTime: scheduledTime.toISOString(),
  }).catch(() => { /* best-effort */ });

  const cache = env.CACHE;
  if (!cache) {
    safeLog.warn('[Scheduled] CACHE KV not configured (locks/throttles disabled)');
  }

  // Track sub-job results for diagnostics
  const jobResults: Record<string, { status: string; durationMs?: number; error?: string }> = {};

  /**
   * Run a sub-job with error isolation and diagnostics.
   * Each sub-job runs independently — one failure doesn't block others.
   */
  async function runJob(name: string, fn: () => Promise<void>): Promise<void> {
    const jobStart = Date.now();
    try {
      await fn();
      jobResults[name] = { status: 'success', durationMs: Date.now() - jobStart };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      jobResults[name] = { status: 'error', durationMs: Date.now() - jobStart, error: message };
      safeLog.error(`[Scheduled] Job "${name}" failed`, { error: message });
      // Record individual job failure
      await recordCronRun(env, name, 'error', undefined, message).catch(() => {});
    }
  }

  switch (controller.cron) {
    case CRON_QUICK_DEAL_LINK: {
      // Keep this narrow: do NOT run Gmail/Limitless here.
      await runJob('receipt_deal_link_backfill', async () => {
        const res = await backfillReceiptDealLinks(env, { limit: 2 });
        if (res.scanned > 0) {
          safeLog.info('[Scheduled] Quick receipt-deal link backfill summary', res);
        }
      });
      break;
    }

    case CRON_HOURLY: {
      // Gmail-only mode: skip all other jobs
      if (env.SCHEDULED_GMAIL_ONLY === 'true') {
        await runJob('gmail_polling', () => handleGmailReceiptPolling(env));
        break;
      }

      // Primary: Gmail receipt polling
      await runJob('gmail_polling', () => handleGmailReceiptPolling(env));

      // Recovery: receipts stuck due to transient Gmail poll failures
      await runJob('receipt_recovery', async () => {
        const res = await recoverPdfReceiptsNeedingFreeeUpload(env);
        if (res.scanned > 0) {
          safeLog.info('[Scheduled] Receipt recovery summary', res);
        }
      });

      // Remediation: ensure Deals have receipt evidence linked (legacy missing receipt_ids)
      await runJob('receipt_deal_link_backfill', async () => {
        const res = await backfillReceiptDealLinks(env);
        if (res.scanned > 0) {
          safeLog.info('[Scheduled] Receipt-deal link backfill summary', res);
        }
      });

      // Health check: alert if last successful poll is stale (>6h)
      if (cache && env.DISCORD_WEBHOOK_URL) {
        await runJob('health_check', async () => {
          const lastPoll = await cache.get(HEALTH.LAST_POLL_KEY);
          if (lastPoll) {
            const hoursSinceLastPoll = (Date.now() - new Date(lastPoll).getTime()) / (1000 * 60 * 60);
            if (hoursSinceLastPoll > HEALTH.ALERT_NO_POLL_HOURS) {
              await fetch(env.DISCORD_WEBHOOK_URL!, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  content: `🚨 **Receipt Pipeline Stale**\n` +
                    `Last successful poll: ${lastPoll} (${hoursSinceLastPoll.toFixed(1)}h ago)\n` +
                    `Threshold: ${HEALTH.ALERT_NO_POLL_HOURS}h\n` +
                    `Check Gmail poller logs.`,
                }),
              });
            }
          }
        });
      }

      // Secondary: Limitless backup sync
      await runJob('limitless_sync', () => handleLimitlessSync(env));

      // Optional: daemon health check
      if (env.DAEMON_HEALTH_CRON_ENABLED === 'true' && cache) {
        await runJob('daemon_health', () => handleDaemonHealthCheck(env, withLock));
      }

      // Optional: Limitless poller
      if (env.LIMITLESS_POLLER_ENABLED === 'true') {
        await runJob('limitless_poller', () => handleLimitlessPollerCron(env));
      }

      // Sub-jobs: time-gated within hourly cron
      const hour = scheduledTime.getUTCHours();

      // PHI verification: every 6 hours (0, 6, 12, 18 UTC)
      if (hour % 6 === 0) {
        await runJob('phi_verification', () => handlePhiVerificationCron(env));
      }

      // Subscription cleanup: daily at 02:00 UTC (11:00 JST)
      if (hour === 2 && cache) {
        await runJob('subscription_cleanup', () => handleSubscriptionCleanup(env, withLock));
      }

      // One-time backfill: re-classify existing receipts and create deals
      if (env.RECEIPT_BACKFILL_ENABLED === 'true') {
        await runJob('receipt_backfill', async () => {
          const { handleReceiptBackfillCron } = await import('./receipt-backfill');
          await handleReceiptBackfillCron(env);
        });
      }

      break;
    }

    case CRON_DAILY_ACTIONS:
      await runJob('daily_actions', () => handleDailyActionCheck(env, withLock));
      break;

    case CRON_WEEKLY_DIGEST:
      await runJob('weekly_digest', () => handleWeeklyDigest(env, withLock));
      break;

    default:
      safeLog.warn('[Scheduled] Unknown cron expression', { cron: controller.cron });
  }

  // Record overall cron completion with all job results
  const totalDurationMs = Date.now() - startTime;
  const hasErrors = Object.values(jobResults).some(r => r.status === 'error');

  safeLog.info('[Scheduled] Cron run completed', {
    cron: controller.cron,
    durationMs: totalDurationMs,
    jobResults,
    hasErrors,
  });

  await recordCronRun(
    env,
    `cron:${controller.cron}`,
    hasErrors ? 'error' : 'success',
    { __buildTag: SCHEDULED_BUILD_TAG, ...jobResults, durationMs: totalDurationMs },
    hasErrors ? Object.entries(jobResults)
      .filter(([, r]) => r.status === 'error')
      .map(([name, r]) => `${name}: ${r.error}`)
      .join('; ') : undefined
  ).catch(() => { /* best-effort */ });

  // Purge old cron_runs (keep 30 days, run daily at 03:00 UTC)
  if (controller.cron === CRON_HOURLY && scheduledTime.getUTCHours() === 3 && env.DB) {
    try {
      await env.DB.prepare(
        `DELETE FROM cron_runs WHERE executed_at < datetime('now', '-30 days')`
      ).run();
    } catch {
      // best-effort
    }
  }
}

// ============================================================================
// Handler: Hourly Limitless Sync (existing logic, extracted)
// ============================================================================

async function handleLimitlessSync(env: Env): Promise<void> {
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

  // Best-effort KV throttling. Even if KV writes are rate-limited, the sync should still run:
  // Supabase upsert on limitless_id is idempotent and prevents duplicates.
  const cache = env.CACHE;
  const lastSyncKey = `limitless:backup_sync:${env.LIMITLESS_USER_ID}`;
  if (cache) {
    try {
      const lastSyncData = await cache.get(lastSyncKey);

      if (lastSyncData) {
        const lastSync = new Date(lastSyncData);
        const timeDiffMs = Date.now() - lastSync.getTime();

        // Guard: Prevent negative time differences
        if (timeDiffMs >= 0) {
          const hoursSinceLastSync = timeDiffMs / (1000 * 60 * 60);
          const driftGraceHours = 0.05; // 3 minutes
          if (hoursSinceLastSync < syncIntervalHours - driftGraceHours) {
            safeLog.info('[Scheduled] Skipping backup sync (too soon)', {
              lastSync: lastSync.toISOString(),
              hoursSinceLastSync: hoursSinceLastSync.toFixed(2),
              minInterval: syncIntervalHours,
            });
            return;
          }
        }
      }
    } catch (error) {
      safeLog.warn('[Scheduled] KV read failed (throttle disabled)', { error: String(error) });
    }
  }

  const startTime = Date.now();
  let result: Awaited<ReturnType<typeof syncToSupabase>>;
  try {
    result = await syncToSupabase(env, env.LIMITLESS_API_KEY, {
      userId: env.LIMITLESS_USER_ID,
      maxAgeHours: syncIntervalHours + 2,
      includeAudio: false,
      maxItems: 5,
      // Supabase check constraint currently permits only 'webhook' for processed_lifelogs.sync_source.
      syncSource: 'webhook',
    });
  } catch (error) {
    safeLog.error('[Scheduled] Limitless backup sync failed', {
      userId: env.LIMITLESS_USER_ID,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  const duration = Date.now() - startTime;

  if (cache) {
    try {
      await cache.put(lastSyncKey, new Date().toISOString());

      const statsKey = `limitless:backup_stats:${env.LIMITLESS_USER_ID}`;
      const stats = {
        lastSync: new Date().toISOString(),
        synced: result.synced,
        skipped: result.skipped,
        errors: result.errors.length,
        durationMs: duration,
        purpose: 'backup',
      };
      await cache.put(statsKey, JSON.stringify(stats));

      // Persist a small sample of errors for post-mortem via KV (no log retention required).
      const errorKey = `limitless:backup_last_errors:${env.LIMITLESS_USER_ID}`;
      if (result.errors.length > 0) {
        await cache.put(
          errorKey,
          JSON.stringify({
            lastSync: new Date().toISOString(),
            errors: result.errors.slice(0, 10),
          }),
          { expirationTtl: 7 * 24 * 60 * 60 } // 7 days
        );
      } else {
        await cache.delete(errorKey);
      }
    } catch (error) {
      safeLog.warn('[Scheduled] KV write failed (stats/throttle not updated)', { error: String(error) });
    }
  }

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
}

// ============================================================================
// Handler: Subscription Cleanup (Push Notifications)
// ============================================================================

/**
 * Clean up expired push subscriptions
 *
 * Criteria for cleanup:
 * 1. last_notified > 30 days ago (inactive)
 * 2. created_at > 90 days ago AND never notified (abandoned)
 */
async function handleSubscriptionCleanup(
  env: Env,
  withLock: (kv: KVNamespace, lockKey: string, ttlSeconds: number, handler: () => Promise<void>) => Promise<void>
): Promise<void> {
  const lockKey = 'push:subscription_cleanup_lock';

  await withLock(env.CACHE!, lockKey, 300, async () => {
    if (!env.DB) {
      safeLog.warn('[SubscriptionCleanup] DB not configured, skipping cleanup');
      return;
    }

    const now = Math.floor(Date.now() / 1000); // Unix timestamp
    const thirtyDaysAgo = now - 30 * 24 * 60 * 60;
    const ninetyDaysAgo = now - 90 * 24 * 60 * 60;

    safeLog.info('[SubscriptionCleanup] Starting cleanup', {
      thirtyDaysAgo: new Date(thirtyDaysAgo * 1000).toISOString(),
      ninetyDaysAgo: new Date(ninetyDaysAgo * 1000).toISOString(),
    });

    // 1. Deactivate subscriptions not notified in 30 days
    const { success: deactivateSuccess, meta: deactivateMeta } = await env.DB.prepare(
      `UPDATE push_subscriptions
       SET active = 0
       WHERE active = 1
       AND last_notified IS NOT NULL
       AND last_notified < ?`
    )
      .bind(thirtyDaysAgo)
      .run();

    const deactivatedCount = deactivateMeta?.changes || 0;

    if (deactivatedCount > 0) {
      safeLog.info('[SubscriptionCleanup] Deactivated inactive subscriptions', {
        count: deactivatedCount,
      });
    }

    // 2. Delete abandoned subscriptions (never notified, created > 90 days ago)
    const { success: deleteSuccess, meta: deleteMeta } = await env.DB.prepare(
      `DELETE FROM push_subscriptions
       WHERE last_notified IS NULL
       AND created_at < ?`
    )
      .bind(ninetyDaysAgo)
      .run();

    const deletedCount = deleteMeta?.changes || 0;

    if (deletedCount > 0) {
      safeLog.info('[SubscriptionCleanup] Deleted abandoned subscriptions', {
        count: deletedCount,
      });
    }

    // 3. Count remaining active subscriptions
    const { results: countResults } = await env.DB.prepare(
      'SELECT COUNT(*) as count FROM push_subscriptions WHERE active = 1'
    ).all<{ count: number }>();

    const activeCount = countResults?.[0]?.count || 0;

    safeLog.info('[SubscriptionCleanup] Cleanup completed', {
      deactivated: deactivatedCount,
      deleted: deletedCount,
      remainingActive: activeCount,
    });
  });
}
