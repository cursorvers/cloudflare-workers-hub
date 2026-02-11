/**
 * Autopilot Notification Dispatcher
 *
 * Fire-and-forget notifications on mode transitions and safety events.
 * Supports Discord webhook and Slack webhook.
 * Non-blocking: failures are logged but never affect main flow.
 */

import type { Env } from '../../../types';
import { safeLog } from '../../../utils/log-sanitizer';

// =============================================================================
// Types
// =============================================================================

export const NOTIFICATION_TYPES = [
  'auto_stop',
  'recovery_started',
  'recovery_completed',
  'budget_warning',
  'budget_critical',
  'circuit_open',
  'heartbeat_stale',
] as const;

export type NotificationType = typeof NOTIFICATION_TYPES[number];

export interface NotificationPayload {
  readonly type: NotificationType;
  readonly title: string;
  readonly message: string;
  readonly severity: 'critical' | 'warning' | 'info';
  readonly metadata?: Record<string, unknown>;
  readonly timestamp: number;
}

export interface NotificationResult {
  readonly type: NotificationType;
  readonly channel: 'discord' | 'slack' | 'none';
  readonly sent: boolean;
  readonly error?: string;
}

// =============================================================================
// Notification Templates
// =============================================================================

const SEVERITY_COLORS: Record<string, number> = {
  critical: 0xFF0000,
  warning: 0xFFA500,
  info: 0x00FF00,
};

const SEVERITY_EMOJI: Record<string, string> = {
  critical: '\u{1F6A8}',
  warning: '\u26A0\uFE0F',
  info: '\u2139\uFE0F',
};

export function createNotification(
  type: NotificationType,
  details: Record<string, unknown> = {},
): NotificationPayload {
  const templates: Record<NotificationType, { title: string; message: string; severity: NotificationPayload['severity'] }> = {
    auto_stop: {
      title: 'Autopilot Auto-STOP Triggered',
      message: 'Autopilot has been automatically stopped. Reasons: ' + String(details.reasons ?? 'unknown') + '. Manual recovery required.',
      severity: 'critical',
    },
    recovery_started: {
      title: 'Autopilot Recovery Started',
      message: 'Recovery initiated by ' + String(details.approvedBy ?? 'system') + '. Evaluating health gates...',
      severity: 'info',
    },
    recovery_completed: {
      title: 'Autopilot Recovery Completed',
      message: 'Autopilot has been restored to NORMAL mode by ' + String(details.approvedBy ?? 'system') + '.',
      severity: 'info',
    },
    budget_warning: {
      title: 'Autopilot Budget Warning',
      message: 'Budget usage at ' + String(details.percentage ?? '?') + '%. Approaching critical threshold.',
      severity: 'warning',
    },
    budget_critical: {
      title: 'Autopilot Budget CRITICAL',
      message: 'Budget usage at ' + String(details.percentage ?? '?') + '%. Auto-stop imminent.',
      severity: 'critical',
    },
    circuit_open: {
      title: 'Circuit Breaker OPEN',
      message: 'Circuit breaker opened after ' + String(details.failures ?? '?') + ' consecutive failures.',
      severity: 'critical',
    },
    heartbeat_stale: {
      title: 'Heartbeat Stale',
      message: 'No heartbeat received for ' + String(details.ageMs ?? '?') + 'ms. System may be unresponsive.',
      severity: 'warning',
    },
  };

  const template = templates[type];
  return Object.freeze({
    type,
    title: template.title,
    message: template.message,
    severity: template.severity,
    metadata: Object.keys(details).length > 0 ? Object.freeze({ ...details }) : undefined,
    timestamp: Date.now(),
  });
}

// =============================================================================
// Discord Webhook
// =============================================================================

export function buildDiscordPayload(notification: NotificationPayload): Record<string, unknown> {
  const emoji = SEVERITY_EMOJI[notification.severity] ?? '';
  const color = SEVERITY_COLORS[notification.severity] ?? 0x808080;

  return {
    embeds: [{
      title: emoji + ' ' + notification.title,
      description: notification.message,
      color,
      timestamp: new Date(notification.timestamp).toISOString(),
      footer: { text: 'FUGUE Autopilot v1.2' },
      fields: notification.metadata
        ? Object.entries(notification.metadata).slice(0, 5).map(([k, v]) => ({
            name: k,
            value: String(v),
            inline: true,
          }))
        : [],
    }],
  };
}

async function sendDiscord(
  webhookUrl: string,
  notification: NotificationPayload,
): Promise<NotificationResult> {
  try {
    const payload = buildDiscordPayload(notification);
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      return Object.freeze({
        type: notification.type,
        channel: 'discord' as const,
        sent: false,
        error: 'Discord webhook returned ' + response.status,
      });
    }

    return Object.freeze({
      type: notification.type,
      channel: 'discord' as const,
      sent: true,
    });
  } catch (err) {
    return Object.freeze({
      type: notification.type,
      channel: 'discord' as const,
      sent: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// =============================================================================
// Slack Webhook
// =============================================================================

export function buildSlackPayload(notification: NotificationPayload): Record<string, unknown> {
  const emoji = SEVERITY_EMOJI[notification.severity] ?? '';

  return {
    text: emoji + ' *' + notification.title + '*',
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: emoji + ' ' + notification.title, emoji: true },
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: notification.message },
      },
      {
        type: 'context',
        elements: [
          { type: 'mrkdwn', text: '*Severity:* ' + notification.severity + ' | *Time:* ' + new Date(notification.timestamp).toISOString() },
        ],
      },
    ],
  };
}

async function sendSlack(
  webhookUrl: string,
  notification: NotificationPayload,
): Promise<NotificationResult> {
  try {
    const payload = buildSlackPayload(notification);
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      return Object.freeze({
        type: notification.type,
        channel: 'slack' as const,
        sent: false,
        error: 'Slack webhook returned ' + response.status,
      });
    }

    return Object.freeze({
      type: notification.type,
      channel: 'slack' as const,
      sent: true,
    });
  } catch (err) {
    return Object.freeze({
      type: notification.type,
      channel: 'slack' as const,
      sent: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// =============================================================================
// Dispatcher (Fire-and-Forget)
// =============================================================================

export async function dispatchNotification(
  env: Env,
  notification: NotificationPayload,
): Promise<NotificationResult> {
  if (env.DISCORD_WEBHOOK_URL) {
    const result = await sendDiscord(env.DISCORD_WEBHOOK_URL, notification);
    if (result.sent) return result;
    safeLog.warn('[NotificationDispatcher] Discord failed, trying Slack', {
      error: result.error,
    });
  }

  if (env.SLACK_WEBHOOK_URL) {
    const result = await sendSlack(env.SLACK_WEBHOOK_URL, notification);
    if (result.sent) return result;
    safeLog.warn('[NotificationDispatcher] Slack failed', {
      error: result.error,
    });
    return result;
  }

  safeLog.warn('[NotificationDispatcher] No webhook channels configured');
  return Object.freeze({
    type: notification.type,
    channel: 'none' as const,
    sent: false,
    error: 'No webhook channels configured',
  });
}

export function fireAndForget(
  env: Env,
  notification: NotificationPayload,
  ctx?: ExecutionContext,
): void {
  const promise = dispatchNotification(env, notification).catch((err) => {
    safeLog.error('[NotificationDispatcher] Fire-and-forget error', {
      type: notification.type,
      error: err instanceof Error ? err.message : String(err),
    });
  });

  if (ctx) {
    ctx.waitUntil(promise);
  }
}
