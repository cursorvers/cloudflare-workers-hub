import { describe, expect, it } from 'vitest';

import {
  createHealthProbeState,
  recordProbeResult,
  isProbeOverdue,
  getHealthSnapshot,
  isProviderHealthy,
  PROVIDER_IDS,
  PROBE_INTERVAL_MS,
  MAX_PROBE_HISTORY,
  type ProbeResult,
  type ProviderId,
} from '../provider-probe';

// =============================================================================
// Helpers
// =============================================================================

function makeProbeResult(
  provider: ProviderId,
  available: boolean,
  latencyMs = 100,
  timestamp = Date.now(),
): ProbeResult {
  return Object.freeze({
    provider,
    available,
    latencyMs,
    error: available ? undefined : 'test error',
    timestamp,
  });
}

// =============================================================================
// Tests
// =============================================================================

describe('Phase 5b: provider-probe', () => {
  describe('createHealthProbeState', () => {
    it('creates state with all providers defaulting to available', () => {
      const state = createHealthProbeState();

      for (const id of PROVIDER_IDS) {
        const health = state.providers.get(id);
        expect(health).toBeDefined();
        expect(health!.available).toBe(true);
        expect(health!.successRate).toBe(1.0);
      }

      expect(state.lastProbeAt).toBe(0);
    });

    it('has exactly 3 providers', () => {
      expect(PROVIDER_IDS).toEqual(['openai', 'glm', 'gemini']);
    });
  });

  describe('recordProbeResult', () => {
    it('records successful probe', () => {
      let state = createHealthProbeState();
      const result = makeProbeResult('openai', true, 150, 1000);
      state = recordProbeResult(state, result);

      const health = state.providers.get('openai')!;
      expect(health.available).toBe(true);
      expect(health.lastProbe?.latencyMs).toBe(150);
      expect(health.successRate).toBe(1.0);
      expect(health.avgLatencyMs).toBe(150);
      expect(state.lastProbeAt).toBe(1000);
    });

    it('records failed probe and updates success rate', () => {
      let state = createHealthProbeState();
      state = recordProbeResult(state, makeProbeResult('openai', true, 100, 1000));
      state = recordProbeResult(state, makeProbeResult('openai', false, 0, 2000));

      const health = state.providers.get('openai')!;
      expect(health.available).toBe(false);
      expect(health.successRate).toBe(0.5); // 1/2
    });

    it('maintains sliding window of MAX_PROBE_HISTORY', () => {
      let state = createHealthProbeState();
      for (let i = 0; i < MAX_PROBE_HISTORY + 5; i++) {
        state = recordProbeResult(state, makeProbeResult('openai', true, 100, 1000 + i));
      }

      const health = state.providers.get('openai')!;
      expect(health.recentResults).toHaveLength(MAX_PROBE_HISTORY);
    });

    it('calculates average latency from available probes only', () => {
      let state = createHealthProbeState();
      state = recordProbeResult(state, makeProbeResult('glm', true, 200, 1000));
      state = recordProbeResult(state, makeProbeResult('glm', true, 300, 2000));
      state = recordProbeResult(state, makeProbeResult('glm', false, 0, 3000)); // Failed: excluded

      const health = state.providers.get('glm')!;
      expect(health.avgLatencyMs).toBe(250); // (200+300)/2
    });

    it('ignores unknown provider', () => {
      const state = createHealthProbeState();
      const result = makeProbeResult('unknown' as ProviderId, true);
      const nextState = recordProbeResult(state, result);
      expect(nextState).toBe(state); // Unchanged
    });
  });

  describe('isProbeOverdue', () => {
    it('returns true when no probes have been run', () => {
      const state = createHealthProbeState();
      expect(isProbeOverdue(state, Date.now())).toBe(true);
    });

    it('returns false when recently probed', () => {
      let state = createHealthProbeState();
      state = recordProbeResult(state, makeProbeResult('openai', true, 100, 1000));
      expect(isProbeOverdue(state, 1000 + PROBE_INTERVAL_MS - 1)).toBe(false);
    });

    it('returns true when probe interval has elapsed', () => {
      let state = createHealthProbeState();
      state = recordProbeResult(state, makeProbeResult('openai', true, 100, 1000));
      expect(isProbeOverdue(state, 1000 + PROBE_INTERVAL_MS)).toBe(true);
    });
  });

  describe('getHealthSnapshot', () => {
    it('returns frozen array of all providers', () => {
      const state = createHealthProbeState();
      const snapshot = getHealthSnapshot(state);

      expect(snapshot).toHaveLength(3);
      expect(Object.isFrozen(snapshot)).toBe(true);
    });
  });

  describe('isProviderHealthy', () => {
    it('returns true when no data (optimistic)', () => {
      const state = createHealthProbeState();
      expect(isProviderHealthy(state, 'openai')).toBe(true);
    });

    it('returns true when success rate > 50%', () => {
      let state = createHealthProbeState();
      state = recordProbeResult(state, makeProbeResult('openai', true, 100, 1000));
      state = recordProbeResult(state, makeProbeResult('openai', true, 100, 2000));
      state = recordProbeResult(state, makeProbeResult('openai', false, 0, 3000));
      // 2/3 = 66.7% > 50%
      expect(isProviderHealthy(state, 'openai')).toBe(true);
    });

    it('returns false when success rate <= 50%', () => {
      let state = createHealthProbeState();
      state = recordProbeResult(state, makeProbeResult('openai', false, 0, 1000));
      state = recordProbeResult(state, makeProbeResult('openai', false, 0, 2000));
      // 0/2 = 0% <= 50%
      expect(isProviderHealthy(state, 'openai')).toBe(false);
    });
  });

  describe('immutability', () => {
    it('all state transitions produce frozen objects', () => {
      let state = createHealthProbeState();
      expect(Object.isFrozen(state)).toBe(true);

      state = recordProbeResult(state, makeProbeResult('openai', true));
      expect(Object.isFrozen(state)).toBe(true);

      const health = state.providers.get('openai')!;
      expect(Object.isFrozen(health)).toBe(true);
      expect(Object.isFrozen(health.recentResults)).toBe(true);
    });
  });

  describe('constants', () => {
    it('PROBE_INTERVAL_MS is 2 minutes', () => {
      expect(PROBE_INTERVAL_MS).toBe(2 * 60 * 1000);
    });

    it('MAX_PROBE_HISTORY is 10', () => {
      expect(MAX_PROBE_HISTORY).toBe(10);
    });
  });
});
