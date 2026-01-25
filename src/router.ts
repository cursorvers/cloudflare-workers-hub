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

export function detectSource(request: Request): WebhookEvent['source'] | 'telegram' | 'whatsapp' {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path.includes('/slack')) return 'slack';
  if (path.includes('/discord')) return 'discord';
  if (path.includes('/telegram')) return 'telegram';
  if (path.includes('/whatsapp')) return 'whatsapp';
  if (path.includes('/clawdbot')) return 'clawdbot';
  if (path.includes('/github')) return 'github';
  if (path.includes('/stripe')) return 'stripe';
  return 'unknown';
}
