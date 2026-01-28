/**
 * Router Utilities
 *
 * Provides utility functions for request routing:
 * - Source detection from URL paths
 * - Event ID generation
 * - Path matching
 */

import { WebhookEvent } from './types';

export function generateEventId(): string {
  return `evt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/** O(1) lookup map for source detection from path segments */
const SOURCE_MAP = new Map<string, WebhookEvent['source'] | 'telegram' | 'whatsapp'>([
  ['slack', 'slack'],
  ['discord', 'discord'],
  ['telegram', 'telegram'],
  ['whatsapp', 'whatsapp'],
  ['clawdbot', 'clawdbot'],
  ['github', 'github'],
  ['stripe', 'stripe'],
]);

export function detectSource(request: Request): WebhookEvent['source'] | 'telegram' | 'whatsapp' {
  const url = new URL(request.url);
  const segments = url.pathname.split('/');

  for (const segment of segments) {
    const source = SOURCE_MAP.get(segment);
    if (source) return source;
  }

  return 'unknown';
}
