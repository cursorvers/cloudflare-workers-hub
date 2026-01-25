/**
 * Scheduled Handler for Cron Triggers
 *
 * Handles scheduled tasks triggered by Cloudflare Workers Cron:
 * - Automatic Limitless.ai sync
 * - Scheduled maintenance tasks
 */

import { Env } from '../types';
import { safeLog } from '../utils/log-sanitizer';
import { syncToKnowledge } from '../services/limitless';

/**
 * Handle scheduled events from Cloudflare Workers Cron
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

  try {
    // Check if Limitless auto-sync is enabled
    const autoSyncEnabled = env.LIMITLESS_AUTO_SYNC_ENABLED === 'true';

    if (!autoSyncEnabled) {
      safeLog.info('[Scheduled] Limitless auto-sync is disabled');
      return;
    }

    // Check if LIMITLESS_API_KEY is configured
    if (!env.LIMITLESS_API_KEY) {
      safeLog.warn('[Scheduled] LIMITLESS_API_KEY not configured, skipping sync');
      return;
    }

    // Check if LIMITLESS_USER_ID is configured
    if (!env.LIMITLESS_USER_ID) {
      safeLog.warn('[Scheduled] LIMITLESS_USER_ID not configured, skipping sync');
      return;
    }

    // Get sync interval (default: 24 hours for backup)
    const syncIntervalHours = parseInt(env.LIMITLESS_SYNC_INTERVAL_HOURS || '24', 10);

    safeLog.info('[Scheduled] Starting Limitless backup sync', {
      userId: env.LIMITLESS_USER_ID,
      syncIntervalHours,
      purpose: 'catch-up backup (primary sync via iPhone webhook)',
    });

    // Check last backup sync time from KV
    const lastSyncKey = `limitless:backup_sync:${env.LIMITLESS_USER_ID}`;
    let shouldSync = true;

    if (env.CACHE) {
      const lastSyncData = await env.CACHE.get(lastSyncKey);

      if (lastSyncData) {
        const lastSync = new Date(lastSyncData);
        const hoursSinceLastSync = (Date.now() - lastSync.getTime()) / (1000 * 60 * 60);

        if (hoursSinceLastSync < syncIntervalHours) {
          safeLog.info('[Scheduled] Skipping backup sync (too soon)', {
            lastSync: lastSync.toISOString(),
            hoursSinceLastSync: hoursSinceLastSync.toFixed(2),
            minInterval: syncIntervalHours,
          });
          shouldSync = false;
        }
      }
    }

    if (!shouldSync) {
      return;
    }

    // Perform backup sync (longer time range to catch any missed items)
    // This acts as a safety net for items not caught by iPhone triggers
    const startTime = Date.now();
    const result = await syncToKnowledge(env, env.LIMITLESS_API_KEY, {
      userId: env.LIMITLESS_USER_ID,
      maxAgeHours: syncIntervalHours + 2, // Fetch slightly more to ensure no gaps
      includeAudio: false, // Don't download audio for backup sync (save bandwidth)
    });

    const duration = Date.now() - startTime;

    // Update last backup sync time in KV
    if (env.CACHE) {
      await env.CACHE.put(lastSyncKey, new Date().toISOString());

      // Update backup sync stats
      const statsKey = `limitless:backup_stats:${env.LIMITLESS_USER_ID}`;
      const stats = {
        lastSync: new Date().toISOString(),
        synced: result.synced,
        skipped: result.skipped,
        errors: result.errors.length,
        durationMs: duration,
        purpose: 'backup',
      };
      await env.CACHE.put(statsKey, JSON.stringify(stats));
    }

    safeLog.info('[Scheduled] Limitless backup sync completed', {
      userId: env.LIMITLESS_USER_ID,
      synced: result.synced,
      skipped: result.skipped,
      errors: result.errors.length,
      durationMs: duration,
      note: result.synced > 0 ? 'Caught items missed by iPhone triggers' : 'No new items',
    });

    // Log errors if any
    if (result.errors.length > 0) {
      safeLog.warn('[Scheduled] Sync completed with errors', {
        errors: result.errors.slice(0, 5), // Log first 5 errors
      });
    }
  } catch (error) {
    safeLog.error('[Scheduled] Auto-sync failed', {
      error: String(error),
    });

    // Don't throw - let the cron continue running
  }
}
