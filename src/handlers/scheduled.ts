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
import { handleDaemonHealthCheck } from './daemon-monitor';
import {
  handleWeeklyDigest,
  handleDailyActionCheck,
  handleMonthlyDigest,
  handleAnnualDigest,
} from './scheduled-digest';
import { handlePhiVerificationCron } from './phi-verification-cron';
import { handleLimitlessPollerCron } from './limitless-poller';

// ============================================================================
// Cron Expression Constants
// ============================================================================

const CRON_HOURLY_SYNC = '0 * * * *';
const CRON_DAILY_ACTIONS = '0 21 * * *';   // 21:00 UTC = 06:00 JST
const CRON_WEEKLY_DIGEST = '0 0 * * SUN';  // Sun 00:00 UTC = Sun 09:00 JST
const CRON_PHI_VERIFICATION = '0 */6 * * *'; // Every 6 hours (Phase 6.2)
const CRON_SUBSCRIPTION_CLEANUP = '0 2 * * *'; // 02:00 UTC = 11:00 JST (daily cleanup)

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
      // Run all tasks independently with separate locks
      await Promise.all([
        handleLimitlessSync(env),
        handleDaemonHealthCheck(env, withLock),
        handleLimitlessPollerCron(env).catch((error) => {
          safeLog.error('[Scheduled] Limitless poller failed', { error: String(error) });
        }),
      ]);
      return;

    case CRON_DAILY_ACTIONS:
      return handleDailyActionCheck(env, withLock);

    case CRON_WEEKLY_DIGEST:
      return handleWeeklyDigest(env, withLock);

    case CRON_PHI_VERIFICATION:
      return handlePhiVerificationCron(env);

    case CRON_SUBSCRIPTION_CLEANUP:
      return handleSubscriptionCleanup(env, withLock);

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
      syncSource: 'backup',
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
