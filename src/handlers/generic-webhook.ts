/**
 * Generic Webhook Handler
 *
 * Processes normalized events:
 * - Simple queries via Workers AI
 * - Complex requests forwarded to Orchestrator via CommHub
 */

import { NormalizedEvent, Env } from '../types';
import { CommHubAdapter } from '../adapters/commhub';
import { handleWithWorkersAI } from '../ai';
import { safeLog } from '../utils/log-sanitizer';

// Module-level state (initialized once from index.ts)
let _commHub: CommHubAdapter;
let _cacheVersion: string;

/**
 * Initialize the generic webhook handler with shared dependencies.
 * Must be called before handleGenericWebhook or forwardToOrchestrator.
 */
export function initGenericWebhook(commHub: CommHubAdapter, cacheVersion: string): void {
  _commHub = commHub;
  _cacheVersion = cacheVersion;
}

/**
 * Forward complex events to Claude Orchestrator via CommHub
 */
export async function forwardToOrchestrator(event: NormalizedEvent): Promise<Response> {
  const response = await _commHub.processEvent(event);

  return new Response(JSON.stringify({
    status: response.status,
    eventId: event.id,
    message: response.message,
    estimatedCompletion: response.estimatedCompletion,
  }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Handle a normalized event: Workers AI for simple queries, Orchestrator for complex ones.
 */
export async function handleGenericWebhook(event: NormalizedEvent, env: Env): Promise<Response> {
  // Log event without PII (content is not logged, only length)
  safeLog.log(`[Event] ${event.id}`, { source: event.source, type: event.type, contentLength: event.content.length });

  // Cache event metadata (if KV is available)
  if (env.CACHE) {
    await env.CACHE.put(`${_cacheVersion}:event:${event.id}`, JSON.stringify(event), { expirationTtl: 3600 });
  }

  if (!event.requiresOrchestrator) {
    // Handle simple queries with Workers AI
    const response = await handleWithWorkersAI(env, event);
    return new Response(JSON.stringify({
      eventId: event.id,
      response,
      handledBy: 'workers-ai',
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Forward complex requests to Orchestrator
  return forwardToOrchestrator(event);
}
