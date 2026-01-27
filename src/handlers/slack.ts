/**
 * Slack Webhook Handler
 *
 * Slack Events API からのイベントを処理し、
 * チャネルに応じて適切なアクションを実行する。
 */

import { NormalizedEvent, Env } from '../types';
import { safeLog } from '../utils/log-sanitizer';
import { handleGenericWebhook } from './generic-webhook';
import { broadcastNotification, notifications } from './notifications';
import { isSimpleQuery, handleWithWorkersAI } from '../ai';

export interface SlackEvent {
  token?: string;
  challenge?: string;
  type: string;
  event?: {
    type: string;
    text?: string;
    user?: string;
    channel?: string;
    ts?: string;
    thread_ts?: string;
    bot_id?: string;
  };
  team_id?: string;
  api_app_id?: string;
}

export interface SlackResponse {
  ok: boolean;
  challenge?: string;
  message?: string;
  error?: string;
}

// Channel routing rules
const CHANNEL_RULES: Record<string, ChannelRule> = {
  'vibe-coding': {
    autoExecute: true,
    allowedActions: ['code', 'refactor', 'review', 'test'],
    delegateTo: 'codex',
  },
  'approvals': {
    autoExecute: false,
    requiresConsensus: true,
    allowedActions: ['approve', 'reject', 'review'],
  },
  'alerts': {
    autoExecute: false,
    notificationOnly: true,
  },
};

interface ChannelRule {
  autoExecute: boolean;
  allowedActions?: string[];
  delegateTo?: string;
  requiresConsensus?: boolean;
  notificationOnly?: boolean;
}

/**
 * Verify Slack request signature using HMAC-SHA256
 * https://api.slack.com/authentication/verifying-requests-from-slack
 */
export async function verifySlackSignature(
  signature: string | null,
  timestamp: string | null,
  body: string,
  signingSecret: string
): Promise<boolean> {
  if (!signature || !timestamp || !signingSecret) return false;

  // Check timestamp is within 5 minutes (replay attack prevention)
  const now = Math.floor(Date.now() / 1000);
  const requestTimestamp = parseInt(timestamp, 10);
  if (isNaN(requestTimestamp) || Math.abs(now - requestTimestamp) > 300) {
    safeLog.warn('[Slack] Request timestamp too old or invalid');
    return false;
  }

  // Compute expected signature using HMAC-SHA256
  const baseString = `v0:${timestamp}:${body}`;

  try {
    const encoder = new TextEncoder();
    const keyData = encoder.encode(signingSecret);
    const messageData = encoder.encode(baseString);

    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );

    const signatureBuffer = await crypto.subtle.sign('HMAC', cryptoKey, messageData);

    // Convert to hex string
    const expectedHash = Array.from(new Uint8Array(signatureBuffer))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    const expectedSignature = `v0=${expectedHash}`;

    // Constant-time comparison to prevent timing attacks
    if (signature.length !== expectedSignature.length) {
      return false;
    }

    let result = 0;
    for (let i = 0; i < signature.length; i++) {
      result |= signature.charCodeAt(i) ^ expectedSignature.charCodeAt(i);
    }
    return result === 0;
  } catch (error) {
    safeLog.error('[Slack] Signature verification error:', error);
    return false;
  }
}

/**
 * Handle Slack URL verification challenge
 */
export function handleChallenge(event: SlackEvent): SlackResponse {
  if (event.type === 'url_verification' && event.challenge) {
    return { ok: true, challenge: event.challenge };
  }
  return { ok: false, error: 'Invalid challenge' };
}

/**
 * Determine channel name from channel ID
 */
function getChannelName(channelId: string, channelMap: Record<string, string>): string {
  return channelMap[channelId] || 'unknown';
}

/**
 * Parse Slack event into normalized event
 */
export function normalizeSlackEvent(
  event: SlackEvent,
  channelMap: Record<string, string> = {}
): NormalizedEvent | null {
  if (!event.event) return null;

  const slackEvent = event.event;
  const channelId = slackEvent.channel || '';
  const channelName = getChannelName(channelId, channelMap);
  const rule = CHANNEL_RULES[channelName];

  return {
    id: `slack_${slackEvent.ts || Date.now()}`,
    source: 'slack',
    type: slackEvent.type || 'message',
    content: slackEvent.text || '',
    metadata: {
      user: slackEvent.user,
      channel: channelId,
      channelName,
      threadTs: slackEvent.thread_ts,
      teamId: event.team_id,
      rule: rule ? {
        autoExecute: rule.autoExecute,
        requiresConsensus: rule.requiresConsensus,
        delegateTo: rule.delegateTo,
      } : null,
    },
    requiresOrchestrator: !rule?.notificationOnly,
  };
}

/**
 * Check if action is allowed in channel
 */
export function isActionAllowed(channelName: string, action: string): boolean {
  const rule = CHANNEL_RULES[channelName];
  if (!rule) return true; // Unknown channels allow all

  if (rule.notificationOnly) return false;
  if (!rule.allowedActions) return true;

  return rule.allowedActions.includes(action);
}

/**
 * Check if channel requires consensus for action
 */
export function requiresConsensus(channelName: string): boolean {
  const rule = CHANNEL_RULES[channelName];
  return rule?.requiresConsensus ?? false;
}

/**
 * Check if channel auto-executes
 */
export function shouldAutoExecute(channelName: string): boolean {
  const rule = CHANNEL_RULES[channelName];
  return rule?.autoExecute ?? false;
}

/**
 * Post a message to Slack channel
 */
export async function postMessage(
  channel: string,
  text: string,
  botToken: string,
  threadTs?: string
): Promise<boolean> {
  try {
    const response = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${botToken}`,
      },
      body: JSON.stringify({
        channel,
        text,
        thread_ts: threadTs, // Reply in thread if specified
      }),
    });

    const result = await response.json() as { ok: boolean; error?: string };
    if (!result.ok) {
      safeLog.error('Slack postMessage error:', result.error);
      return false;
    }
    return true;
  } catch (error) {
    safeLog.error('Slack postMessage failed:', error);
    return false;
  }
}

/**
 * Handle incoming Slack webhook request end-to-end:
 * signature verification, normalization, FAQ offload, Orchestrator forwarding.
 */
export async function handleSlackWebhook(request: Request, env: Env): Promise<Response> {
  const body = await request.text();
  let payload: SlackEvent;

  try {
    payload = JSON.parse(body);
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  // Verify Slack signature FIRST (if signing secret is configured)
  // All Slack requests including url_verification are signed
  if (env.SLACK_SIGNING_SECRET) {
    const signature = request.headers.get('x-slack-signature');
    const timestamp = request.headers.get('x-slack-request-timestamp');
    const isValid = await verifySlackSignature(signature, timestamp, body, env.SLACK_SIGNING_SECRET);
    if (!isValid) {
      safeLog.warn('[Slack] Invalid signature');
      return new Response('Invalid signature', { status: 401 });
    }
  }

  // Handle Slack URL verification challenge (after signature is verified)
  if (payload.type === 'url_verification') {
    const response = handleChallenge(payload);
    return new Response(JSON.stringify(response), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Normalize and process event
  const event = normalizeSlackEvent(payload);
  if (!event) {
    return new Response('OK', { status: 200 });
  }

  // Ignore bot messages to prevent loops
  if (payload.event?.user === undefined || payload.event?.bot_id) {
    return new Response('OK', { status: 200 });
  }

  const channel = payload.event?.channel;
  const threadTs = payload.event?.thread_ts || payload.event?.ts;

  // Check channel rules
  const channelName = event.metadata.channelName as string;
  if (requiresConsensus(channelName)) {
    await broadcastNotification(
      notifications.approvalRequired(event.content, `Slack #${channelName}`),
      { slackWebhookUrl: undefined }
    );
  }

  // Handle simple queries with Workers AI and reply
  const isSimple = isSimpleQuery(event.content);
  if (isSimple && env.SLACK_BOT_TOKEN && channel) {
    const aiResponse = await handleWithWorkersAI(env, event);
    await postMessage(channel, aiResponse, env.SLACK_BOT_TOKEN, threadTs);
    return new Response('OK', { status: 200 });
  }

  // Complex queries: acknowledge and forward to Orchestrator
  if (env.SLACK_BOT_TOKEN && channel) {
    await postMessage(
      channel,
      '処理中です... Orchestrator に転送しました。',
      env.SLACK_BOT_TOKEN,
      threadTs
    );
  }

  return handleGenericWebhook(event, env);
}

export default {
  verifySlackSignature,
  handleChallenge,
  normalizeSlackEvent,
  isActionAllowed,
  requiresConsensus,
  shouldAutoExecute,
  postMessage,
  handleSlackWebhook,
};
