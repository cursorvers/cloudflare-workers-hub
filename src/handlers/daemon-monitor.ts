/**
 * Daemon Health Monitor
 *
 * Hourly health check for daemon heartbeat status.
 * Sends Discord alerts when no active daemons are detected.
 *
 * Features:
 * - False alert prevention (daemon:ever_registered flag)
 * - Alert rate limiting (max 1/hour via KV TTL)
 * - Consecutive alert tracking with auto-reset on recovery
 */

import { Env } from '../types';
import { safeLog } from '../utils/log-sanitizer';
import { sendDiscordNotification, type Notification } from './notifications';
import { getDaemonHealth } from './daemon';

/** Alert rate limit: 1 alert per hour */
const DAEMON_ALERT_COOLDOWN_SEC = 3600;

export async function handleDaemonHealthCheck(
  env: Env,
  withLock: (kv: KVNamespace, lockKey: string, ttl: number, handler: () => Promise<void>) => Promise<void>,
): Promise<void> {
  const lockKey = 'daemon:health_check_lock';

  await withLock(env.CACHE!, lockKey, 120, async () => {
    if (!env.DISCORD_WEBHOOK_URL) {
      // No notification channel configured, skip
      return;
    }

    let health: Awaited<ReturnType<typeof getDaemonHealth>>;
    try {
      health = await getDaemonHealth(env);
    } catch (error) {
      safeLog.error('[DaemonHealthCheck] Failed to get daemon health', { error: String(error) });
      return;
    }

    const { stale, totalActive } = health;

    // Check if any daemon was ever registered (avoid false alerts on fresh deploys)
    const everRegistered = await env.CACHE!.get('daemon:ever_registered');
    if (!everRegistered && totalActive === 0 && stale.length === 0) {
      // No daemon has ever registered, don't alert
      return;
    }

    // Mark as ever-registered if we see active daemons
    if (totalActive > 0 && !everRegistered) {
      await env.CACHE!.put('daemon:ever_registered', 'true');
    }

    // All good: active daemons exist
    if (totalActive > 0) {
      safeLog.info('[DaemonHealthCheck] Daemons healthy', {
        active: totalActive,
        stale: stale.length,
      });
      // Clear consecutive alert counter on healthy check
      await env.CACHE!.delete('daemon:alert:consecutive');
      return;
    }

    // No active daemons — check rate limit before alerting
    const lastAlertTime = await env.CACHE!.get('daemon:alert:last');
    if (lastAlertTime) {
      const elapsed = (Date.now() - new Date(lastAlertTime).getTime()) / 1000;
      if (elapsed < DAEMON_ALERT_COOLDOWN_SEC) {
        safeLog.info('[DaemonHealthCheck] Alert cooldown active', {
          elapsed: Math.round(elapsed) + 's',
          cooldown: DAEMON_ALERT_COOLDOWN_SEC + 's',
        });
        return;
      }
    }

    // Track consecutive alerts
    const consecutiveRaw = await env.CACHE!.get('daemon:alert:consecutive');
    const consecutive = consecutiveRaw ? parseInt(consecutiveRaw, 10) + 1 : 1;
    await env.CACHE!.put('daemon:alert:consecutive', String(consecutive), { expirationTtl: 86400 });

    // Build stale daemon details
    const staleDetails = stale.map(d => {
      const age = Math.round((Date.now() - new Date(d.lastHeartbeat).getTime()) / 1000);
      return `${d.daemonId} (last heartbeat: ${age}s ago)`;
    });

    const notification: Notification = {
      type: 'error',
      title: 'Daemon Offline Alert',
      message: totalActive === 0 && stale.length === 0
        ? 'すべてのデーモンがオフラインです。Mac Mini の状態を確認してください。'
        : `アクティブなデーモンがありません。${stale.length}件のデーモンがstaleです。`,
      source: 'daemon-monitor',
      fields: [
        { name: 'Active', value: String(totalActive), inline: true },
        { name: 'Stale', value: String(stale.length), inline: true },
        { name: 'Consecutive Alerts', value: String(consecutive), inline: true },
        ...(staleDetails.length > 0
          ? [{ name: 'Stale Daemons', value: staleDetails.join('\n') }]
          : []),
      ],
    };

    try {
      await sendDiscordNotification(env.DISCORD_WEBHOOK_URL, notification);
      await env.CACHE!.put('daemon:alert:last', new Date().toISOString(), {
        expirationTtl: DAEMON_ALERT_COOLDOWN_SEC,
      });
      safeLog.warn('[DaemonHealthCheck] Offline alert sent', {
        stale: stale.length,
        consecutive,
      });
    } catch (error) {
      safeLog.error('[DaemonHealthCheck] Failed to send alert', { error: String(error) });
    }
  });
}
