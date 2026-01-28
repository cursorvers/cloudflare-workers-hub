/**
 * Discord Webhook Handler
 *
 * Discord Interactions からのイベントを処理し、
 * チャネルに応じて適切なアクションを実行する。
 */

import { NormalizedEvent, Env } from '../types';
import { safeLog } from '../utils/log-sanitizer';
import { handleGenericWebhook } from './generic-webhook';
import { DiscordWebhookSchema } from '../schemas/discord';

export interface DiscordInteraction {
  type: number; // 1=PING, 2=APPLICATION_COMMAND, 3=MESSAGE_COMPONENT
  id: string;
  application_id: string;
  token: string;
  data?: {
    id: string;
    name: string;
    options?: Array<{
      name: string;
      type: number;
      value: string;
    }>;
  };
  guild_id?: string;
  channel_id?: string;
  member?: {
    user: {
      id: string;
      username: string;
    };
  };
  message?: {
    id: string;
    content: string;
  };
}

export interface DiscordResponse {
  type: number; // 1=PONG, 4=CHANNEL_MESSAGE, 5=DEFERRED_MESSAGE
  data?: {
    content?: string;
    flags?: number; // 64 = ephemeral
  };
}

// Discord interaction types
const InteractionType = {
  PING: 1,
  APPLICATION_COMMAND: 2,
  MESSAGE_COMPONENT: 3,
  APPLICATION_COMMAND_AUTOCOMPLETE: 4,
  MODAL_SUBMIT: 5,
} as const;

// Discord response types
const InteractionResponseType = {
  PONG: 1,
  CHANNEL_MESSAGE_WITH_SOURCE: 4,
  DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5,
  DEFERRED_UPDATE_MESSAGE: 6,
  UPDATE_MESSAGE: 7,
} as const;

// Channel routing rules (same structure as Slack)
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
 * Verify Discord request signature using Ed25519
 * Uses SubtleCrypto with proper key format for Cloudflare Workers
 */
export async function verifyDiscordSignature(
  signature: string | null,
  timestamp: string | null,
  body: string,
  publicKey: string
): Promise<boolean> {
  if (!signature || !timestamp || !publicKey) return false;

  try {
    const encoder = new TextEncoder();
    const message = encoder.encode(timestamp + body);
    const signatureBytes = hexToUint8Array(signature);
    const publicKeyBytes = hexToUint8Array(publicKey);

    // Import public key for Ed25519
    const key = await crypto.subtle.importKey(
      'raw',
      publicKeyBytes,
      {
        name: 'NODE-ED25519',
        namedCurve: 'NODE-ED25519',
      },
      true,
      ['verify']
    );

    // Verify signature
    const isValid = await crypto.subtle.verify(
      'NODE-ED25519',
      key,
      signatureBytes,
      message
    );

    return isValid;
  } catch (error) {
    safeLog.error('Discord signature verification error:', error);
    return false;
  }
}

function hexToUint8Array(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return bytes;
}

/**
 * Handle Discord PING (for URL verification)
 */
export function handlePing(): DiscordResponse {
  return { type: InteractionResponseType.PONG };
}

/**
 * Check if interaction is a PING
 */
export function isPing(interaction: DiscordInteraction): boolean {
  return interaction.type === InteractionType.PING;
}

/**
 * Parse Discord interaction into normalized event
 */
export function normalizeDiscordEvent(
  interaction: DiscordInteraction,
  channelMap: Record<string, string> = {}
): NormalizedEvent | null {
  if (interaction.type === InteractionType.PING) return null;

  const channelId = interaction.channel_id || '';
  const channelName = channelMap[channelId] || 'unknown';
  const rule = CHANNEL_RULES[channelName];

  let content = '';
  if (interaction.data?.name) {
    // Slash command
    const options = interaction.data.options?.map(o => `${o.name}:${o.value}`).join(' ') || '';
    content = `/${interaction.data.name} ${options}`.trim();
  } else if (interaction.message?.content) {
    content = interaction.message.content;
  }

  return {
    id: `discord_${interaction.id}`,
    source: 'discord',
    type: interaction.type === InteractionType.APPLICATION_COMMAND ? 'command' : 'interaction',
    content,
    metadata: {
      user: interaction.member?.user.id,
      username: interaction.member?.user.username,
      channel: channelId,
      channelName,
      guildId: interaction.guild_id,
      interactionToken: interaction.token,
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
 * Create a deferred response (for long-running tasks)
 */
export function createDeferredResponse(): DiscordResponse {
  return {
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
  };
}

/**
 * Create a message response
 */
export function createMessageResponse(
  content: string,
  ephemeral: boolean = false
): DiscordResponse {
  return {
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      content,
      flags: ephemeral ? 64 : undefined,
    },
  };
}

/**
 * Check if action is allowed in channel
 */
export function isActionAllowed(channelName: string, action: string): boolean {
  const rule = CHANNEL_RULES[channelName];
  if (!rule) return true;
  if (rule.notificationOnly) return false;
  if (!rule.allowedActions) return true;
  return rule.allowedActions.includes(action);
}

/**
 * Check if channel requires consensus
 */
export function requiresConsensus(channelName: string): boolean {
  const rule = CHANNEL_RULES[channelName];
  return rule?.requiresConsensus ?? false;
}

/**
 * Handle incoming Discord webhook request end-to-end:
 * signature verification, PING handling, normalization, deferred response.
 */
export async function handleDiscordWebhook(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const body = await request.text();

  // Verify Discord signature FIRST (required by Discord)
  if (env.DISCORD_PUBLIC_KEY) {
    const signature = request.headers.get('x-signature-ed25519');
    const timestamp = request.headers.get('x-signature-timestamp');
    const isValid = await verifyDiscordSignature(signature, timestamp, body, env.DISCORD_PUBLIC_KEY);
    if (!isValid) {
      return new Response('Invalid signature', { status: 401 });
    }
  }

  let rawPayload: unknown;
  try {
    rawPayload = JSON.parse(body);
  } catch {
    return new Response(
      JSON.stringify({ error: 'Invalid JSON in request body' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Validate payload with Zod
  const validation = DiscordWebhookSchema.safeParse(rawPayload);
  if (!validation.success) {
    safeLog.warn('[Discord] Validation failed', { errors: validation.error.errors });
    return new Response(
      JSON.stringify({
        error: 'Validation failed',
        details: validation.error.errors,
      }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const payload = validation.data as DiscordInteraction;

  // Handle Discord PING for verification
  if (isPing(payload)) {
    return new Response(JSON.stringify(handlePing()), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Normalize and process event
  const event = normalizeDiscordEvent(payload);
  if (!event) {
    return new Response(JSON.stringify({ type: 1 }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // For Discord, return deferred response and process async
  const deferredResponse = createDeferredResponse();

  // Process in background using ctx.waitUntil to prevent premature termination
  const backgroundWork = handleGenericWebhook(event, env).catch((err) => safeLog.error('[Discord] Background processing error', { error: String(err) }));
  if (ctx) {
    ctx.waitUntil(backgroundWork);
  }

  return new Response(JSON.stringify(deferredResponse), {
    headers: { 'Content-Type': 'application/json' },
  });
}

export default {
  verifyDiscordSignature,
  handlePing,
  isPing,
  normalizeDiscordEvent,
  createDeferredResponse,
  createMessageResponse,
  isActionAllowed,
  requiresConsensus,
  handleDiscordWebhook,
};
