/**
 * Tests for provider-resilience.ts (v1.3 provider failover routing).
 */

import { describe, it, expect } from 'vitest';
import {
  selectProvider,
  classifyProviderStatus,
  getProviderStatuses,
  executeWithFailover,
  DEFAULT_ROUTING_CONFIG,
  HEALTHY_THRESHOLD,
  DEGRADED_THRESHOLD,
  type LLMAdapter,
  type LLMChatRequest,
  type AdapterRegistry,
  type RoutingConfig,
} from '../provider-resilience';
import {
  createHealthProbeState,
  recordProbeResult,
  type HealthProbeState,
  type ProbeResult,
} from '../provider-probe';

// =============================================================================
// Helpers
// =============================================================================

const NOW = 1_700_000_000_000;

function makeProbe(provider: 'openai' | 'glm' | 'gemini', available: boolean, latencyMs = 100): ProbeResult {
  return Object.freeze({
    provider,
    available,
    latencyMs,
    error: available ? undefined : 'probe failed',
    timestamp: NOW,
  });
}

function makeHealthState(probes: ProbeResult[]): HealthProbeState {
  let state = createHealthProbeState();
  for (const probe of probes) {
    state = recordProbeResult(state, probe);
  }
  return state;
}

function makeMockAdapter(providerId: 'openai' | 'glm' | 'gemini', shouldFail = false): LLMAdapter {
  return {
    providerId,
    chat: async (req: LLMChatRequest) => {
      if (shouldFail) throw new Error(`${providerId} failed`);
      return Object.freeze({
        provider: providerId,
        content: `response from ${providerId}`,
        model: `${providerId}-model`,
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
      });
    },
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('provider-resilience', () => {
  describe('classifyProviderStatus', () => {
    it('classifies healthy provider', () => {
      const health = makeHealthState([makeProbe('openai', true)]).providers.get('openai')!;
      expect(classifyProviderStatus(health)).toBe('healthy');
    });

    it('classifies provider with 0% success rate as down', () => {
      const health = makeHealthState([
        makeProbe('openai', false),
        makeProbe('openai', false),
        makeProbe('openai', false),
      ]).providers.get('openai')!;
      expect(health.successRate).toBe(0);
      expect(classifyProviderStatus(health)).toBe('down');
    });

    it('classifies degraded provider (mixed success rate)', () => {
      let state = createHealthProbeState();
      // 5 successes, 5 failures = 50% success rate → degraded
      for (let i = 0; i < 5; i++) {
        state = recordProbeResult(state, makeProbe('openai', true));
        state = recordProbeResult(state, makeProbe('openai', false));
      }
      const health = state.providers.get('openai')!;
      const status = classifyProviderStatus(health);
      // Success rate = 0.5 → between DEGRADED_THRESHOLD (0.3) and HEALTHY_THRESHOLD (0.8)
      expect(status).toBe('degraded');
    });
  });

  describe('selectProvider', () => {
    it('selects first healthy provider in preferred order', () => {
      const health = makeHealthState([
        makeProbe('openai', true),
        makeProbe('glm', true),
        makeProbe('gemini', true),
      ]);

      const result = selectProvider(health);
      expect(result.provider).toBe('openai');
      expect(result.status).toBe('healthy');
      expect(result.fallbackUsed).toBe(false);
    });

    it('skips unhealthy providers to find first healthy', () => {
      const health = makeHealthState([
        makeProbe('openai', false),
        makeProbe('glm', true),
        makeProbe('gemini', true),
      ]);

      const result = selectProvider(health);
      expect(result.provider).toBe('glm');
      expect(result.status).toBe('healthy');
    });

    it('falls back to degraded when no healthy providers', () => {
      let state = createHealthProbeState();
      // openai: down
      state = recordProbeResult(state, makeProbe('openai', false));
      // glm: degraded (50% success)
      for (let i = 0; i < 5; i++) {
        state = recordProbeResult(state, makeProbe('glm', true));
        state = recordProbeResult(state, makeProbe('glm', false));
      }
      // gemini: down
      state = recordProbeResult(state, makeProbe('gemini', false));

      const result = selectProvider(state);
      expect(result.provider).toBe('glm');
      expect(result.status).toBe('degraded');
      expect(result.fallbackUsed).toBe(true);
    });

    it('returns first provider as fallback when all down', () => {
      const health = makeHealthState([
        makeProbe('openai', false),
        makeProbe('glm', false),
        makeProbe('gemini', false),
      ]);

      const result = selectProvider(health);
      expect(result.provider).toBe('openai');
      expect(result.fallbackUsed).toBe(true);
    });

    it('respects custom preferred order', () => {
      const health = makeHealthState([
        makeProbe('openai', true),
        makeProbe('glm', true),
        makeProbe('gemini', true),
      ]);

      const config: RoutingConfig = Object.freeze({
        preferredOrder: ['gemini', 'glm', 'openai'],
        allowDegraded: true,
      });

      const result = selectProvider(health, config);
      expect(result.provider).toBe('gemini');
    });

    it('skips degraded when allowDegraded is false', () => {
      let state = createHealthProbeState();
      state = recordProbeResult(state, makeProbe('openai', false));
      for (let i = 0; i < 5; i++) {
        state = recordProbeResult(state, makeProbe('glm', true));
        state = recordProbeResult(state, makeProbe('glm', false));
      }
      state = recordProbeResult(state, makeProbe('gemini', false));

      const config: RoutingConfig = Object.freeze({
        preferredOrder: ['openai', 'glm', 'gemini'],
        allowDegraded: false,
      });

      const result = selectProvider(state, config);
      // Should fall back to first, not degraded glm
      expect(result.provider).toBe('openai');
      expect(result.fallbackUsed).toBe(true);
    });

    it('returns frozen selection object', () => {
      const health = makeHealthState([makeProbe('openai', true)]);
      const result = selectProvider(health);
      expect(Object.isFrozen(result)).toBe(true);
    });
  });

  describe('getProviderStatuses', () => {
    it('returns status map for all providers', () => {
      const health = makeHealthState([
        makeProbe('openai', true),
        makeProbe('glm', false),
        makeProbe('gemini', true),
      ]);

      const statuses = getProviderStatuses(health);
      expect(statuses.get('openai')).toBe('healthy');
      expect(statuses.get('glm')).toBe('down');
      expect(statuses.get('gemini')).toBe('healthy');
    });
  });

  describe('executeWithFailover', () => {
    const request: LLMChatRequest = Object.freeze({
      messages: [{ role: 'user' as const, content: 'test' }],
    });

    it('routes to healthy primary provider', async () => {
      const health = makeHealthState([
        makeProbe('openai', true),
        makeProbe('glm', true),
      ]);

      const registry: AdapterRegistry = {
        openai: makeMockAdapter('openai'),
        glm: makeMockAdapter('glm'),
        gemini: makeMockAdapter('gemini'),
      };

      const result = await executeWithFailover(request, registry, health);
      expect(result.provider).toBe('openai');
      expect(result.content).toBe('response from openai');
    });

    it('fails over to next provider when primary fails', async () => {
      const health = makeHealthState([
        makeProbe('openai', true),
        makeProbe('glm', true),
      ]);

      const registry: AdapterRegistry = {
        openai: makeMockAdapter('openai', true), // fails
        glm: makeMockAdapter('glm'),
        gemini: makeMockAdapter('gemini'),
      };

      const result = await executeWithFailover(request, registry, health);
      expect(result.provider).toBe('glm');
    });

    it('throws when all providers fail', async () => {
      const health = makeHealthState([
        makeProbe('openai', true),
        makeProbe('glm', true),
        makeProbe('gemini', true),
      ]);

      const registry: AdapterRegistry = {
        openai: makeMockAdapter('openai', true),
        glm: makeMockAdapter('glm', true),
        gemini: makeMockAdapter('gemini', true),
      };

      await expect(
        executeWithFailover(request, registry, health),
      ).rejects.toThrow('All providers failed');
    });

    it('skips providers without adapters', async () => {
      const health = makeHealthState([
        makeProbe('openai', true),
        makeProbe('glm', true),
      ]);

      const registry: AdapterRegistry = {
        openai: undefined, // no adapter
        glm: makeMockAdapter('glm'),
        gemini: undefined,
      };

      const result = await executeWithFailover(request, registry, health);
      expect(result.provider).toBe('glm');
    });
  });
});
