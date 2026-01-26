/**
 * Event Normalizer
 *
 * Normalizes raw webhook payloads from various sources
 * into the standard NormalizedEvent format.
 */

import { WebhookEvent, NormalizedEvent } from '../types';
import { generateEventId } from '../router';
import { isSimpleQuery } from '../ai';

export async function normalizeEvent(
  source: WebhookEvent['source'],
  payload: unknown
): Promise<NormalizedEvent> {
  const id = generateEventId();
  let content = '';
  let type = 'unknown';
  let metadata: Record<string, unknown> = {};

  switch (source) {
    case 'slack':
      const slackPayload = payload as { event?: { text?: string; type?: string; user?: string } };
      content = slackPayload.event?.text || '';
      type = slackPayload.event?.type || 'message';
      metadata = { user: slackPayload.event?.user };
      break;

    case 'discord':
      const discordPayload = payload as { content?: string; author?: { id: string } };
      content = discordPayload.content || '';
      type = 'message';
      metadata = { author: discordPayload.author?.id };
      break;

    case 'clawdbot':
      const clawdPayload = payload as { message?: string; channel?: string; user?: string };
      content = clawdPayload.message || '';
      type = 'customer_message';
      metadata = { channel: clawdPayload.channel, user: clawdPayload.user };
      break;

    default:
      content = JSON.stringify(payload);
      type = 'raw';
  }

  return {
    id,
    source,
    type,
    content,
    metadata,
    requiresOrchestrator: !isSimpleQuery(content),
  };
}
