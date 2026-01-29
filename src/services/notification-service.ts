/**
 * Notification Service
 *
 * Strategic Advisor Phase 4: Delivery Layer
 *
 * Discord/Slack Webhook 通知、優先度に基づく配信制御
 */

import type { Env } from '../types';
import type { Insight } from '../schemas/strategic-advisor';
import { safeLog } from '../utils/log-sanitizer';

// =============================================================================
// Constants
// =============================================================================

const DISCORD_EMBED_COLOR_MAP: Record<string, number> = {
  strategic: 0x8b5cf6, // Purple
  tactical: 0x3b82f6,  // Blue
  reflective: 0x22c55e, // Green
  questioning: 0xf59e0b, // Amber
};

const PRIORITY_THRESHOLD_DISCORD = 0.7; // Only notify for high-priority insights
const MAX_WEBHOOK_RETRIES = 2;
const WEBHOOK_TIMEOUT_MS = 5000;

// =============================================================================
// Types
// =============================================================================

export interface NotificationConfig {
  discordWebhookUrl?: string;
  slackWebhookUrl?: string;
  enableDiscord?: boolean;
  enableSlack?: boolean;
  minPriorityForNotification?: number;
}

export interface NotificationResult {
  sent: boolean;
  channel: 'discord' | 'slack' | 'none';
  error?: string;
}

interface DiscordEmbed {
  title: string;
  description: string;
  color: number;
  fields: Array<{ name: string; value: string; inline?: boolean }>;
  footer?: { text: string };
  timestamp?: string;
}

// =============================================================================
// Discord Notification
// =============================================================================

function buildDiscordEmbed(insight: Insight): DiscordEmbed {
  const typeEmoji: Record<string, string> = {
    strategic: '⚡',
    tactical: '🎯',
    reflective: '💭',
    questioning: '❓',
  };

  const confidenceBar = (confidence: number): string => {
    const filled = Math.round(confidence / 10);
    return '█'.repeat(filled) + '░'.repeat(10 - filled);
  };

  return {
    title: `${typeEmoji[insight.type] || '💡'} ${insight.title}`,
    description: insight.description || '',
    color: DISCORD_EMBED_COLOR_MAP[insight.type] || 0x5e6ad2,
    fields: [
      {
        name: 'Type',
        value: insight.type.charAt(0).toUpperCase() + insight.type.slice(1),
        inline: true,
      },
      {
        name: 'Confidence',
        value: `${confidenceBar(insight.confidence)} ${insight.confidence}%`,
        inline: true,
      },
      ...(insight.suggestedAction ? [{
        name: 'Suggested Action',
        value: `\`\`\`${insight.suggestedAction.slice(0, 200)}${insight.suggestedAction.length > 200 ? '...' : ''}\`\`\``,
        inline: false,
      }] : []),
    ],
    footer: {
      text: 'FUGUE Strategic Advisor',
    },
    timestamp: new Date().toISOString(),
  };
}

async function sendDiscordNotification(
  webhookUrl: string,
  insight: Insight
): Promise<NotificationResult> {
  const embed = buildDiscordEmbed(insight);

  const payload = {
    username: 'FUGUE Advisor',
    avatar_url: 'https://avatars.githubusercontent.com/u/9919?s=200&v=4', // Cloudflare logo
    embeds: [embed],
  };

  for (let attempt = 0; attempt <= MAX_WEBHOOK_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);

      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (response.ok || response.status === 204) {
        safeLog.log('[Notification] Discord notification sent', {
          insightId: insight.id,
          type: insight.type,
        });
        return { sent: true, channel: 'discord' };
      }

      // Rate limited - wait and retry
      if (response.status === 429) {
        const retryAfter = parseInt(response.headers.get('Retry-After') || '1', 10);
        await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
        continue;
      }

      safeLog.warn('[Notification] Discord webhook failed', {
        status: response.status,
        attempt,
      });
    } catch (error) {
      safeLog.error('[Notification] Discord webhook error', {
        error: error instanceof Error ? error.message : String(error),
        attempt,
      });

      if (attempt === MAX_WEBHOOK_RETRIES) {
        return {
          sent: false,
          channel: 'discord',
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    }
  }

  return { sent: false, channel: 'discord', error: 'Max retries exceeded' };
}

// =============================================================================
// Slack Notification (simplified)
// =============================================================================

async function sendSlackNotification(
  webhookUrl: string,
  insight: Insight
): Promise<NotificationResult> {
  const typeEmoji: Record<string, string> = {
    strategic: '⚡',
    tactical: '🎯',
    reflective: '💭',
    questioning: '❓',
  };

  const payload = {
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `${typeEmoji[insight.type] || '💡'} ${insight.title}`,
          emoji: true,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: insight.description || '_No description_',
        },
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `*Type:* ${insight.type} | *Confidence:* ${insight.confidence}%`,
          },
        ],
      },
    ],
  };

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (response.ok) {
      safeLog.log('[Notification] Slack notification sent', {
        insightId: insight.id,
      });
      return { sent: true, channel: 'slack' };
    }

    return {
      sent: false,
      channel: 'slack',
      error: `HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      sent: false,
      channel: 'slack',
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

// =============================================================================
// Main Notification Function
// =============================================================================

export async function notifyInsight(
  env: Env,
  insight: Insight,
  config?: NotificationConfig
): Promise<NotificationResult> {
  const minPriority = config?.minPriorityForNotification ?? PRIORITY_THRESHOLD_DISCORD;

  // Check if insight meets priority threshold
  if ((insight.confidence / 100) < minPriority) {
    safeLog.log('[Notification] Insight below priority threshold', {
      insightId: insight.id,
      confidence: insight.confidence,
      threshold: minPriority * 100,
    });
    return { sent: false, channel: 'none' };
  }

  // Try Discord first
  const discordUrl = config?.discordWebhookUrl || env.DISCORD_WEBHOOK_URL;
  if (discordUrl && (config?.enableDiscord !== false)) {
    return sendDiscordNotification(discordUrl, insight);
  }

  // Fallback to Slack
  const slackUrl = config?.slackWebhookUrl || (env as { SLACK_WEBHOOK_URL?: string }).SLACK_WEBHOOK_URL;
  if (slackUrl && config?.enableSlack) {
    return sendSlackNotification(slackUrl, insight);
  }

  return { sent: false, channel: 'none' };
}

// =============================================================================
// Batch Notification (for daily digest)
// =============================================================================

export async function notifyDailyDigest(
  env: Env,
  insights: Insight[]
): Promise<NotificationResult> {
  const discordUrl = env.DISCORD_WEBHOOK_URL;
  if (!discordUrl) {
    return { sent: false, channel: 'none' };
  }

  const highPriority = insights.filter(i => i.confidence >= 80);
  const mediumPriority = insights.filter(i => i.confidence >= 50 && i.confidence < 80);

  const payload = {
    username: 'FUGUE Daily Digest',
    embeds: [{
      title: '📊 Strategic Advisor Daily Summary',
      description: `You have **${insights.length}** pending insights to review.`,
      color: 0x5e6ad2,
      fields: [
        {
          name: '🔴 High Priority',
          value: highPriority.length > 0
            ? highPriority.map(i => `• ${i.title}`).join('\n').slice(0, 1000)
            : '_None_',
          inline: false,
        },
        {
          name: '🟡 Medium Priority',
          value: mediumPriority.length > 0
            ? mediumPriority.map(i => `• ${i.title}`).join('\n').slice(0, 1000)
            : '_None_',
          inline: false,
        },
      ],
      footer: { text: 'Review at /cockpit' },
      timestamp: new Date().toISOString(),
    }],
  };

  try {
    const response = await fetch(discordUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    return {
      sent: response.ok || response.status === 204,
      channel: 'discord',
    };
  } catch (error) {
    return {
      sent: false,
      channel: 'discord',
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
