/**
 * Notification Handler
 *
 * #alerts チャネルへの通知を管理
 * Slack/Discord 両方に対応
 */

import { safeLog } from '../utils/log-sanitizer';

export interface Notification {
  type: 'info' | 'warning' | 'error' | 'success';
  title: string;
  message: string;
  source?: string;
  timestamp?: string;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  actionUrl?: string;
}

export interface SlackBlock {
  type: string;
  text?: { type: string; text: string; emoji?: boolean };
  elements?: Array<unknown>;
  accessory?: unknown;
  fields?: Array<{ type: string; text: string }>;
}

export interface DiscordEmbed {
  title?: string;
  description?: string;
  color?: number;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  timestamp?: string;
  footer?: { text: string };
}

// Color mapping for notification types
const COLORS = {
  info: { slack: '#36a64f', discord: 0x36a64f },
  warning: { slack: '#ff9800', discord: 0xff9800 },
  error: { slack: '#dc3545', discord: 0xdc3545 },
  success: { slack: '#28a745', discord: 0x28a745 },
};

// Emoji mapping for notification types
const EMOJIS = {
  info: 'ℹ️',
  warning: '⚠️',
  error: '🚨',
  success: '✅',
};

/**
 * Format notification for Slack
 */
export function formatSlackNotification(notification: Notification): {
  blocks: SlackBlock[];
  attachments: Array<{ color: string; blocks: SlackBlock[] }>;
} {
  const emoji = EMOJIS[notification.type];
  const color = COLORS[notification.type].slack;

  const blocks: SlackBlock[] = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `${emoji} ${notification.title}`,
        emoji: true,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: notification.message,
      },
    },
  ];

  // Add fields if present
  if (notification.fields && notification.fields.length > 0) {
    blocks.push({
      type: 'section',
      fields: notification.fields.map(f => ({
        type: 'mrkdwn',
        text: `*${f.name}*\n${f.value}`,
      })),
    });
  }

  // Add action button if URL present
  if (notification.actionUrl) {
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: 'View Details',
            emoji: true,
          },
          url: notification.actionUrl,
        },
      ],
    });
  }

  // Add context
  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: `Source: ${notification.source || 'orchestrator-hub'} | ${notification.timestamp || new Date().toISOString()}`,
      },
    ],
  });

  return {
    blocks,
    attachments: [{ color, blocks: [] }],
  };
}

/**
 * Format notification for Discord
 */
export function formatDiscordNotification(notification: Notification): {
  embeds: DiscordEmbed[];
} {
  const color = COLORS[notification.type].discord;
  const emoji = EMOJIS[notification.type];

  const embed: DiscordEmbed = {
    title: `${emoji} ${notification.title}`,
    description: notification.message,
    color,
    timestamp: notification.timestamp || new Date().toISOString(),
    footer: {
      text: notification.source || 'orchestrator-hub',
    },
  };

  if (notification.fields) {
    embed.fields = notification.fields;
  }

  return { embeds: [embed] };
}

/**
 * Send notification to Slack webhook
 */
export async function sendSlackNotification(
  webhookUrl: string,
  notification: Notification
): Promise<boolean> {
  try {
    const payload = formatSlackNotification(notification);
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return response.ok;
  } catch (error) {
    safeLog.error('Failed to send Slack notification:', error);
    return false;
  }
}

/**
 * Send notification to Discord webhook
 */
export async function sendDiscordNotification(
  webhookUrl: string,
  notification: Notification
): Promise<boolean> {
  try {
    const payload = formatDiscordNotification(notification);
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return response.ok;
  } catch (error) {
    safeLog.error('Failed to send Discord notification:', error);
    return false;
  }
}

/**
 * Send notification to both Slack and Discord
 */
export async function broadcastNotification(
  notification: Notification,
  config: {
    slackWebhookUrl?: string;
    discordWebhookUrl?: string;
  }
): Promise<{ slack: boolean; discord: boolean }> {
  const results = await Promise.all([
    config.slackWebhookUrl
      ? sendSlackNotification(config.slackWebhookUrl, notification)
      : Promise.resolve(false),
    config.discordWebhookUrl
      ? sendDiscordNotification(config.discordWebhookUrl, notification)
      : Promise.resolve(false),
  ]);

  return {
    slack: results[0],
    discord: results[1],
  };
}

/**
 * Create standard notifications
 */
export const notifications = {
  taskStarted: (taskId: string, description: string): Notification => ({
    type: 'info',
    title: 'Task Started',
    message: description,
    fields: [{ name: 'Task ID', value: taskId, inline: true }],
  }),

  taskCompleted: (taskId: string, result: string): Notification => ({
    type: 'success',
    title: 'Task Completed',
    message: result,
    fields: [{ name: 'Task ID', value: taskId, inline: true }],
  }),

  taskFailed: (taskId: string, error: string): Notification => ({
    type: 'error',
    title: 'Task Failed',
    message: error,
    fields: [{ name: 'Task ID', value: taskId, inline: true }],
  }),

  approvalRequired: (operation: string, reason: string): Notification => ({
    type: 'warning',
    title: 'Approval Required',
    message: `**Operation:** ${operation}\n**Reason:** ${reason}`,
  }),

  consensusResult: (
    operation: string,
    verdict: string,
    votes: Record<string, number>
  ): Notification => ({
    type: verdict === 'APPROVED' ? 'success' : verdict === 'BLOCKED' ? 'error' : 'warning',
    title: `Consensus: ${verdict}`,
    message: operation,
    fields: Object.entries(votes).map(([k, v]) => ({
      name: k,
      value: String(v),
      inline: true,
    })),
  }),
};

export default {
  formatSlackNotification,
  formatDiscordNotification,
  sendSlackNotification,
  sendDiscordNotification,
  broadcastNotification,
  notifications,
};
