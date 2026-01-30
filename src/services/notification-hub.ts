/**
 * Notification Hub - PWA-First Notification Service
 *
 * All notifications are consolidated to the PWA (Cockpit) dashboard.
 * Discord/Slack are optional fallbacks for when PWA is unavailable.
 *
 * Flow:
 * 1. Store to D1 (cockpit_alerts table)
 * 2. Push to WebSocket (CockpitWebSocket DO)
 * 3. Fallback: Discord (if configured and severity >= warning)
 */

import type { Env } from '../types';
import { safeLog } from '../utils/log-sanitizer';
import { sendDiscordNotification, type Notification } from '../handlers/notifications';

export type NotificationSeverity = 'info' | 'warning' | 'error' | 'success';

export interface CockpitAlert {
  id: string;
  severity: NotificationSeverity;
  title: string;
  message: string;
  source: string;
  createdAt: number;
  acknowledged: boolean;
  metadata?: Record<string, unknown>;
}

/**
 * Send notification to PWA (primary) with optional Discord fallback
 *
 * @param env - Cloudflare Workers environment
 * @param notification - The notification to send
 * @param options - Additional options
 * @returns Result of notification delivery
 */
export async function notify(
  env: Env,
  notification: Notification,
  options?: {
    skipDiscord?: boolean;
    metadata?: Record<string, unknown>;
  }
): Promise<{
  alertId: string | null;
  pwa: boolean;
  discord: boolean;
}> {
  const alertId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  let pwaSuccess = false;
  let discordSuccess = false;

  // 1. Store to D1 (cockpit_alerts)
  if (env.DB) {
    try {
      await env.DB.prepare(`
        INSERT INTO cockpit_alerts (
          id, severity, title, message, source, created_at, acknowledged, metadata
        ) VALUES (?, ?, ?, ?, ?, ?, 0, ?)
      `).bind(
        alertId,
        notification.type,
        notification.title,
        notification.message,
        notification.source || 'system',
        now,
        options?.metadata ? JSON.stringify(options.metadata) : null
      ).run();

      safeLog.log('[NotificationHub] Alert stored', { alertId, title: notification.title });
      pwaSuccess = true;
    } catch (error) {
      safeLog.error('[NotificationHub] Failed to store alert', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // 2. Push to WebSocket (CockpitWebSocket DO)
  if (env.COCKPIT_WS && pwaSuccess) {
    try {
      const doId = env.COCKPIT_WS.idFromName('cockpit');
      const stub = env.COCKPIT_WS.get(doId);

      // Use internal broadcast endpoint
      const wsAlert = {
        id: alertId,
        severity: notification.type,
        title: notification.title,
        message: notification.message,
        source: notification.source || 'system',
        createdAt: now,
        acknowledged: false,
      };

      // We'll broadcast via a message to all connected clients
      // The DO has a /broadcast-alert endpoint we can call
      const response = await stub.fetch('http://internal/broadcast-alert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(wsAlert),
      });

      if (response.ok) {
        safeLog.log('[NotificationHub] Alert pushed to WebSocket', { alertId });
      } else {
        safeLog.warn('[NotificationHub] WebSocket push failed', {
          status: response.status,
        });
      }
    } catch (error) {
      safeLog.warn('[NotificationHub] Failed to push to WebSocket', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // 3. Discord fallback (for warning/error when configured, unless skipped)
  const shouldNotifyDiscord =
    !options?.skipDiscord &&
    env.DISCORD_WEBHOOK_URL &&
    (notification.type === 'warning' || notification.type === 'error');

  if (shouldNotifyDiscord) {
    try {
      discordSuccess = await sendDiscordNotification(
        env.DISCORD_WEBHOOK_URL!,
        notification
      );
      if (discordSuccess) {
        safeLog.log('[NotificationHub] Discord fallback sent', { alertId });
      }
    } catch (error) {
      safeLog.warn('[NotificationHub] Discord fallback failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    alertId: pwaSuccess ? alertId : null,
    pwa: pwaSuccess,
    discord: discordSuccess,
  };
}

/**
 * Create standard notification helpers
 */
export const cockpitNotifications = {
  /** Task-related notifications */
  taskStarted: (taskId: string, description: string): Notification => ({
    type: 'info',
    title: 'タスク開始',
    message: description,
    source: 'task-executor',
    fields: [{ name: 'Task ID', value: taskId, inline: true }],
  }),

  taskCompleted: (taskId: string, result: string): Notification => ({
    type: 'success',
    title: 'タスク完了',
    message: result,
    source: 'task-executor',
    fields: [{ name: 'Task ID', value: taskId, inline: true }],
  }),

  taskFailed: (taskId: string, error: string): Notification => ({
    type: 'error',
    title: 'タスク失敗',
    message: error,
    source: 'task-executor',
    fields: [{ name: 'Task ID', value: taskId, inline: true }],
  }),

  /** Daemon-related notifications */
  daemonOffline: (daemonId: string, lastSeen: string): Notification => ({
    type: 'warning',
    title: 'デーモンオフライン',
    message: `${daemonId} が応答しません`,
    source: 'daemon-monitor',
    fields: [
      { name: 'Daemon ID', value: daemonId, inline: true },
      { name: '最終確認', value: lastSeen, inline: true },
    ],
  }),

  daemonRecovered: (daemonId: string): Notification => ({
    type: 'success',
    title: 'デーモン復旧',
    message: `${daemonId} がオンラインに戻りました`,
    source: 'daemon-monitor',
    fields: [{ name: 'Daemon ID', value: daemonId, inline: true }],
  }),

  /** Git-related notifications */
  gitUncommitted: (repoName: string, fileCount: number): Notification => ({
    type: 'warning',
    title: '未コミット変更',
    message: `${repoName} に ${fileCount} 件の未コミット変更があります`,
    source: 'git-monitor',
    fields: [
      { name: 'リポジトリ', value: repoName, inline: true },
      { name: 'ファイル数', value: String(fileCount), inline: true },
    ],
  }),

  gitPushRequired: (repoName: string, aheadCount: number): Notification => ({
    type: 'info',
    title: 'プッシュ待ち',
    message: `${repoName} に ${aheadCount} 件のプッシュ待ちコミットがあります`,
    source: 'git-monitor',
    fields: [
      { name: 'リポジトリ', value: repoName, inline: true },
      { name: 'コミット数', value: String(aheadCount), inline: true },
    ],
  }),

  /** Consensus-related notifications */
  consensusRequired: (operation: string, reason: string): Notification => ({
    type: 'warning',
    title: '合議が必要',
    message: `**操作:** ${operation}\n**理由:** ${reason}`,
    source: 'consensus',
  }),

  consensusResult: (
    operation: string,
    verdict: 'APPROVED' | 'REJECTED' | 'CONDITIONAL' | 'BLOCKED',
    votes: Record<string, number>
  ): Notification => ({
    type: verdict === 'APPROVED' ? 'success' : verdict === 'BLOCKED' ? 'error' : 'warning',
    title: `合議結果: ${verdict}`,
    message: operation,
    source: 'consensus',
    fields: Object.entries(votes).map(([k, v]) => ({
      name: k,
      value: String(v),
      inline: true,
    })),
  }),

  /** Provider-related notifications */
  providerUnhealthy: (provider: string, errorRate: number): Notification => ({
    type: 'warning',
    title: 'プロバイダー異常',
    message: `${provider} のエラーレートが上昇しています`,
    source: 'observability',
    fields: [
      { name: 'プロバイダー', value: provider, inline: true },
      { name: 'エラーレート', value: `${errorRate.toFixed(1)}%`, inline: true },
    ],
  }),

  /** Budget-related notifications */
  budgetWarning: (provider: string, usedPercent: number): Notification => ({
    type: 'warning',
    title: '予算警告',
    message: `${provider} の予算使用率が ${usedPercent}% に達しました`,
    source: 'budget-monitor',
    fields: [
      { name: 'プロバイダー', value: provider, inline: true },
      { name: '使用率', value: `${usedPercent}%`, inline: true },
    ],
  }),

  /** System-related notifications */
  systemError: (component: string, error: string): Notification => ({
    type: 'error',
    title: 'システムエラー',
    message: `${component}: ${error}`,
    source: component,
  }),

  deployComplete: (version: string, environment: string): Notification => ({
    type: 'success',
    title: 'デプロイ完了',
    message: `バージョン ${version} が ${environment} にデプロイされました`,
    source: 'deployment',
    fields: [
      { name: 'バージョン', value: version, inline: true },
      { name: '環境', value: environment, inline: true },
    ],
  }),
};

export default {
  notify,
  cockpitNotifications,
};
