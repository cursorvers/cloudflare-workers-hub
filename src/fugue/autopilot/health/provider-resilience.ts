/**
 * Provider Resilience — Stateless failover routing for LLM providers.
 *
 * Uses HealthProbeState from provider-probe to select the best available
 * provider. Pure functions, immutable state, no side effects.
 *
 * Failover chain: OpenAI → GLM → Gemini (configurable).
 * Selection priority: healthy > degraded > fallback to first in order.
 *
 * Design: Codex architect recommended "案A: Stateless Selector + Adapter Registry"
 */

import type { ProviderId, HealthProbeState, ProviderHealth } from './provider-probe';
import { PROVIDER_IDS } from './provider-probe';

// =============================================================================
// Constants
// =============================================================================

/** Default failover order */
export const DEFAULT_FAILOVER_ORDER: readonly ProviderId[] = Object.freeze([
  'openai',
  'glm',
  'gemini',
]);

/** Minimum success rate to consider a provider "healthy" */
export const HEALTHY_THRESHOLD = 0.8;

/** Minimum success rate to consider a provider "degraded" (vs down) */
export const DEGRADED_THRESHOLD = 0.3;

// =============================================================================
// Types
// =============================================================================

export type ProviderStatus = 'healthy' | 'degraded' | 'down';

export interface RoutingConfig {
  readonly preferredOrder: readonly ProviderId[];
  readonly allowDegraded: boolean;
}

export interface ProviderSelection {
  readonly provider: ProviderId;
  readonly status: ProviderStatus;
  readonly reason: string;
  readonly fallbackUsed: boolean;
}

/** LLM Adapter interface — normalizes request/response across providers */
export interface LLMAdapter {
  readonly providerId: ProviderId;
  readonly chat: (request: LLMChatRequest) => Promise<LLMChatResponse>;
}

export interface LLMChatRequest {
  readonly model?: string;
  readonly messages: readonly LLMMessage[];
  readonly maxTokens?: number;
  readonly temperature?: number;
}

export interface LLMMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

export interface LLMChatResponse {
  readonly provider: ProviderId;
  readonly content: string;
  readonly model: string;
  readonly usage?: {
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly totalTokens: number;
  };
}

export type AdapterRegistry = Readonly<Record<ProviderId, LLMAdapter | undefined>>;

// =============================================================================
// Default Config
// =============================================================================

export const DEFAULT_ROUTING_CONFIG: RoutingConfig = Object.freeze({
  preferredOrder: DEFAULT_FAILOVER_ORDER,
  allowDegraded: true,
});

// =============================================================================
// Pure Functions
// =============================================================================

/**
 * Classify a provider's health status based on probe results.
 */
export function classifyProviderStatus(health: ProviderHealth): ProviderStatus {
  // Use success rate from sliding window (not just latest probe)
  if (health.successRate >= HEALTHY_THRESHOLD) return 'healthy';
  if (health.successRate >= DEGRADED_THRESHOLD) return 'degraded';
  return 'down';
}

/**
 * Get status for all providers from health probe state.
 */
export function getProviderStatuses(
  healthState: HealthProbeState,
): ReadonlyMap<ProviderId, ProviderStatus> {
  const statuses = new Map<ProviderId, ProviderStatus>();
  for (const id of PROVIDER_IDS) {
    const health = healthState.providers.get(id);
    statuses.set(id, health ? classifyProviderStatus(health) : 'down');
  }
  return statuses;
}

/**
 * Select the best available provider based on health state and preferred order.
 *
 * Selection priority:
 * 1. First healthy provider in preferred order
 * 2. First degraded provider in preferred order (if allowDegraded)
 * 3. Fallback to first provider in order (fail-open for availability)
 */
export function selectProvider(
  healthState: HealthProbeState,
  config: RoutingConfig = DEFAULT_ROUTING_CONFIG,
): ProviderSelection {
  const statuses = getProviderStatuses(healthState);

  // Pass 1: healthy providers
  for (const id of config.preferredOrder) {
    if (statuses.get(id) === 'healthy') {
      return Object.freeze({
        provider: id,
        status: 'healthy',
        reason: `${id} is healthy (success rate >= ${HEALTHY_THRESHOLD})`,
        fallbackUsed: false,
      });
    }
  }

  // Pass 2: degraded providers (if allowed)
  if (config.allowDegraded) {
    for (const id of config.preferredOrder) {
      if (statuses.get(id) === 'degraded') {
        return Object.freeze({
          provider: id,
          status: 'degraded',
          reason: `${id} is degraded but usable; no healthy providers available`,
          fallbackUsed: true,
        });
      }
    }
  }

  // Pass 3: fallback to first in order (fail-open)
  const fallback = config.preferredOrder[0];
  return Object.freeze({
    provider: fallback,
    status: statuses.get(fallback) ?? 'down',
    reason: `all providers degraded/down; falling back to ${fallback}`,
    fallbackUsed: true,
  });
}

/**
 * Execute a chat request with automatic failover.
 * Tries providers in order until one succeeds.
 */
export async function executeWithFailover(
  request: LLMChatRequest,
  registry: AdapterRegistry,
  healthState: HealthProbeState,
  config: RoutingConfig = DEFAULT_ROUTING_CONFIG,
): Promise<LLMChatResponse> {
  const statuses = getProviderStatuses(healthState);
  const errors: Array<{ provider: ProviderId; error: string }> = [];

  // Try providers in preferred order, prioritizing healthy ones
  const ordered = [
    ...config.preferredOrder.filter((id) => statuses.get(id) === 'healthy'),
    ...config.preferredOrder.filter((id) => config.allowDegraded && statuses.get(id) === 'degraded'),
    ...config.preferredOrder.filter((id) => statuses.get(id) === 'down'),
  ];
  // Deduplicate while preserving order
  const uniqueOrdered = [...new Set(ordered)];

  for (const id of uniqueOrdered) {
    const adapter = registry[id];
    if (!adapter) continue;

    try {
      return await adapter.chat(request);
    } catch (err) {
      errors.push({
        provider: id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  throw new Error(
    `All providers failed: ${errors.map((e) => `${e.provider}=${e.error}`).join('; ')}`,
  );
}
