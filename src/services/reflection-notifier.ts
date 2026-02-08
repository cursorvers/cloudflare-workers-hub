/**
 * Reflection Notifier Service (Phase 5)
 *
 * Purpose: Send notifications to users about pending reflections
 * Channels: Discord, Slack, PWA (future)
 */

import { Env } from '../types';
import { safeLog } from '../utils/log-sanitizer';
import type { ReflectionNotification } from '../schemas/user-reflections';

export type { ReflectionNotification } from '../schemas/user-reflections';

/**
 * Notification channel type
 */
export type NotificationChannel = 'discord' | 'slack' | 'pwa';

/**
 * Notification result
 */
export interface NotificationResult {
  success: boolean;
  channel: NotificationChannel;
  message?: string;
  error?: string;
}

/**
 * Send notification to specified channel
 */
export async function sendReflectionNotification(
  env: Env,
  channel: NotificationChannel,
  notification: ReflectionNotification,
  force: boolean = false
): Promise<NotificationResult> {
  // Check frequency control (unless forced)
  if (!force) {
    const canSend = await checkNotificationFrequency(
      env,
      notification.highlight_id,
      channel
    );

    if (!canSend) {
      safeLog.info('[Notifier] Skipping notification due to frequency control', {
        highlight_id: notification.highlight_id,
        channel,
      });

      return {
        success: false,
        channel,
        error: 'notification sent within 24 hours',
      };
    }
  }

  // Send based on channel
  let result: NotificationResult;

  switch (channel) {
    case 'discord':
      result = await sendDiscordNotification(env, notification);
      break;
    case 'slack':
      result = await sendSlackNotification(env, notification);
      break;
    case 'pwa':
      // PWA push notifications - Phase 6
      result = {
        success: false,
        channel: 'pwa',
        message: 'PWA notifications not implemented yet (Phase 6)',
      };
      break;
    default:
      result = {
        success: false,
        channel,
        error: `Unknown channel: ${channel}`,
      };
  }

  // Record notification if successful
  if (result.success) {
    await recordNotification(env, notification.highlight_id, channel);
  }

  return result;
}

/**
 * Send Discord notification
 */
async function sendDiscordNotification(
  env: Env,
  notification: ReflectionNotification
): Promise<NotificationResult> {
  const webhookUrl = env.DISCORD_WEBHOOK_URL;

  if (!webhookUrl) {
    safeLog.warn('[Notifier] Discord webhook URL not configured');
    return {
      success: false,
      channel: 'discord',
      error: 'Discord webhook URL not configured',
    };
  }

  try {
    const message = formatDiscordMessage(notification);

    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(message),
    });

    if (!response.ok) {
      const errorText = typeof (response as any).text === 'function'
        ? await (response as Response).text()
        : ((response as any).statusText ?? '');
      safeLog.error('[Notifier] Discord notification failed', {
        status: response.status,
        error: errorText,
      });

      return {
        success: false,
        channel: 'discord',
        error: `Discord webhook returned ${response.status}`,
      };
    }

    safeLog.info('[Notifier] Discord notification sent successfully', {
      highlight_id: notification.highlight_id,
    });

    return {
      success: true,
      channel: 'discord',
      message: 'Notification sent to Discord',
    };
  } catch (error) {
    safeLog.error('[Notifier] Discord notification error', {
      error: String(error),
    });

    return {
      success: false,
      channel: 'discord',
      error: String(error),
    };
  }
}

/**
 * Send Slack notification
 */
async function sendSlackNotification(
  env: Env,
  notification: ReflectionNotification
): Promise<NotificationResult> {
  const webhookUrl = env.SLACK_WEBHOOK_URL;

  if (!webhookUrl) {
    safeLog.warn('[Notifier] Slack webhook URL not configured');
    return {
      success: false,
      channel: 'slack',
      error: 'Slack webhook URL not configured',
    };
  }

  try {
    const message = formatSlackMessage(notification);

    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(message),
    });

    if (!response.ok) {
      const errorText = typeof (response as any).text === 'function'
        ? await (response as Response).text()
        : ((response as any).statusText ?? '');
      safeLog.error('[Notifier] Slack notification failed', {
        status: response.status,
        error: errorText,
      });

      return {
        success: false,
        channel: 'slack',
        error: `Slack webhook returned ${response.status}`,
      };
    }

    safeLog.info('[Notifier] Slack notification sent successfully', {
      highlight_id: notification.highlight_id,
    });

    return {
      success: true,
      channel: 'slack',
      message: 'Notification sent to Slack',
    };
  } catch (error) {
    safeLog.error('[Notifier] Slack notification error', {
      error: String(error),
    });

    return {
      success: false,
      channel: 'slack',
      error: String(error),
    };
  }
}

/**
 * Format Discord message
 */
function formatDiscordMessage(notification: ReflectionNotification): object {
  const timestamp = new Date(notification.highlight_time).toLocaleString('ja-JP', {
    timeZone: 'Asia/Tokyo',
  });

  return {
    content: '🔔 **振り返りリマインダー**',
    embeds: [
      {
        title: '24時間前のハイライトを振り返りましょう',
        description: notification.extracted_text
          ? `> ${notification.extracted_text.substring(0, 200)}${
              notification.extracted_text.length > 200 ? '...' : ''
            }`
          : '_(テキストなし)_',
        color: 0xff8400, // Orange
        fields: [
          {
            name: '⏰ 記録時刻',
            value: timestamp,
            inline: true,
          },
          {
            name: '🗣️ 話者',
            value: notification.speaker_name || '_(不明)_',
            inline: true,
          },
          {
            name: '🏷️ トピック',
            value:
              notification.topics.length > 0
                ? notification.topics.join(', ')
                : '_(なし)_',
            inline: false,
          },
        ],
        footer: {
          text: 'Phase 5: 協調的振り返りシステム',
        },
        timestamp: new Date().toISOString(),
      },
    ],
    components: [
      {
        type: 1, // Action row
        components: [
          {
            type: 2, // Button
            style: 5, // Link button
            label: '振り返りを記入する',
            url: notification.notification_url,
          },
        ],
      },
    ],
  };
}

/**
 * Format Slack message
 */
function formatSlackMessage(notification: ReflectionNotification): object {
  const timestamp = new Date(notification.highlight_time).toLocaleString('ja-JP', {
    timeZone: 'Asia/Tokyo',
  });

  return {
    text: '🔔 振り返りリマインダー',
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: '24時間前のハイライトを振り返りましょう',
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: notification.extracted_text
            ? `> ${notification.extracted_text.substring(0, 200)}${
                notification.extracted_text.length > 200 ? '...' : ''
              }`
            : '_(テキストなし)_',
        },
      },
      {
        type: 'section',
        fields: [
          {
            type: 'mrkdwn',
            text: `*⏰ 記録時刻:*\n${timestamp}`,
          },
          {
            type: 'mrkdwn',
            text: `*🗣️ 話者:*\n${notification.speaker_name || '_(不明)_'}`,
          },
          {
            type: 'mrkdwn',
            text: `*🏷️ トピック:*\n${
              notification.topics.length > 0
                ? notification.topics.join(', ')
                : '_(なし)_'
            }`,
          },
        ],
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: '振り返りを記入する',
            },
            style: 'primary',
            url: notification.notification_url,
          },
        ],
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: '_Phase 5: 協調的振り返りシステム_',
          },
        ],
      },
    ],
  };
}

/**
 * Check notification frequency (1 notification per day per highlight)
 */
async function checkNotificationFrequency(
  env: Env,
  highlightId: string,
  channel: NotificationChannel
): Promise<boolean> {
  // SECURITY: Early return if CACHE is not configured
  if (!env.CACHE) {
    safeLog.warn('[Notifier] CACHE not configured, skipping frequency control', {
      highlight_id: highlightId,
      channel,
    });
    return true; // Allow notification when cache is unavailable
  }

  const key = `notification:${highlightId}:${channel}`;

  try {
    const lastNotification = await env.CACHE.get(key);

    if (lastNotification) {
      const lastTime = parseInt(lastNotification, 10);
      const now = Date.now();
      const hoursSince = (now - lastTime) / (1000 * 60 * 60);

      // Allow notification if 24+ hours have passed
      return hoursSince >= 24;
    }

    // No previous notification found
    return true;
  } catch (error) {
    safeLog.error('[Notifier] Failed to check notification frequency', {
      error: String(error),
    });

    // Allow notification on error (fail open)
    return true;
  }
}

/**
 * Record notification timestamp
 */
async function recordNotification(
  env: Env,
  highlightId: string,
  channel: NotificationChannel
): Promise<void> {
  // SECURITY: Early return if CACHE is not configured
  if (!env.CACHE) {
    safeLog.warn('[Notifier] CACHE not configured, skipping notification recording', {
      highlight_id: highlightId,
      channel,
    });
    return;
  }

  const key = `notification:${highlightId}:${channel}`;
  const timestamp = Date.now().toString();

  try {
    // Store with 48-hour expiration (2 days)
    await env.CACHE.put(key, timestamp, {
      expirationTtl: 60 * 60 * 48,
    });

    safeLog.info('[Notifier] Notification recorded', {
      highlight_id: highlightId,
      channel,
    });
  } catch (error) {
    safeLog.error('[Notifier] Failed to record notification', {
      error: String(error),
    });
  }
}

/**
 * Send notification to multiple channels
 */
export async function sendMultiChannelNotification(
  env: Env,
  channels: NotificationChannel[],
  notification: ReflectionNotification,
  force: boolean = false
): Promise<NotificationResult[]> {
  const results = await Promise.all(
    channels.map((channel) =>
      sendReflectionNotification(env, channel, notification, force)
    )
  );

  const successCount = results.filter((r) => r.success).length;
  safeLog.info('[Notifier] Multi-channel notification completed', {
    total: channels.length,
    success: successCount,
    failed: channels.length - successCount,
  });

  return results;
}
