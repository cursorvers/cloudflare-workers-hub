import { describe, expect, it, vi } from 'vitest';

import { createCircuitBreakerState, type CircuitBreakerState } from '../../runtime/circuit-breaker';
import type { SpecialistConfig, SpecialistRegistry } from '../../specialist/types';

import {
  createExecutorWorker,
  incrementWeeklyCount,
  cbStorageKey,
  weeklyStorageKey,
  currentIsoWeek,
  type ExecutorStorage,
  type ExecutorFactoryConfig,
} from '../factory';

// =============================================================================
// Mock Storage
// =============================================================================

function createMockStorage(data: Record<string, unknown> = {}): ExecutorStorage {
  const store = new Map<string, unknown>(Object.entries(data));
  return {
    get: vi.fn(async <T>(key: string): Promise<T | undefined> => store.get(key) as T | undefined),
    put: vi.fn(async (entries: Record<string, unknown>): Promise<void> => {
      for (const [k, v] of Object.entries(entries)) store.set(k, v);
    }),
  };
}

function makeEnv() {
  return {
    OPENAI_API_KEY: 'sk-test-openai',
    ZAI_API_KEY: 'zai-test-key',
    GEMINI_API_KEY: 'gem-test-key',
  };
}

function makeRegistry(): SpecialistRegistry {
  return Object.freeze({
    specialists: Object.freeze([
      Object.freeze({ id: 'codex', name: 'Codex', trustLevel: 'TRUSTED', maxRiskTier: 4, enabled: true } as SpecialistConfig),
      Object.freeze({ id: 'glm', name: 'GLM', trustLevel: 'SEMI_TRUSTED', maxRiskTier: 2, enabled: true } as SpecialistConfig),
    ]),
  });
}

// =============================================================================
// Tests
// =============================================================================

describe('executor/factory', () => {
  describe('storage key helpers', () => {
    it('cbStorageKey formats correctly', () => {
      expect(cbStorageKey('codex')).toBe('autopilot:cb:v2:codex');
      expect(cbStorageKey('glm')).toBe('autopilot:cb:v2:glm');
    });

    it('weeklyStorageKey formats correctly', () => {
      expect(weeklyStorageKey('codex', '2026-W07')).toBe('autopilot:weekly:v1:codex:2026-W07');
    });

    it('currentIsoWeek returns valid format', () => {
      const week = currentIsoWeek();
      expect(week).toMatch(/^\d{4}-W\d{2}$/);
    });

    it('currentIsoWeek accepts custom timestamp', () => {
      // 2026-02-12 is Thursday of week 7 of 2026
      const week = currentIsoWeek(new Date('2026-02-12T00:00:00Z').getTime());
      expect(week).toBe('2026-W07');
    });

    it('currentIsoWeek handles year boundary: 2025-12-29 → 2026-W01', () => {
      // 2025-12-29 is Monday; ISO: Thu of that week is 2026-01-01 → W01 of 2026
      const week = currentIsoWeek(new Date('2025-12-29T00:00:00Z').getTime());
      expect(week).toBe('2026-W01');
    });

    it('currentIsoWeek handles year boundary: 2025-12-28 → 2025-W52', () => {
      // 2025-12-28 is Sunday; Thu of that week is 2025-12-25 → W52 of 2025
      const week = currentIsoWeek(new Date('2025-12-28T00:00:00Z').getTime());
      expect(week).toBe('2025-W52');
    });

    it('currentIsoWeek handles year boundary: 2027-01-01 → 2026-W53', () => {
      // 2027-01-01 is Friday; Thu of that week is 2026-12-31 → W53 of 2026
      const week = currentIsoWeek(new Date('2027-01-01T00:00:00Z').getTime());
      expect(week).toBe('2026-W53');
    });

    it('currentIsoWeek handles year boundary: 2027-01-04 → 2027-W01', () => {
      // 2027-01-04 is Monday; Thu of that week is 2027-01-07 → W01 of 2027
      const week = currentIsoWeek(new Date('2027-01-04T00:00:00Z').getTime());
      expect(week).toBe('2027-W01');
    });

    it('currentIsoWeek handles 2024-12-30 → 2025-W01', () => {
      // 2024-12-30 is Monday; Thu of that week is 2025-01-02 → W01 of 2025
      const week = currentIsoWeek(new Date('2024-12-30T00:00:00Z').getTime());
      expect(week).toBe('2025-W01');
    });
  });

  describe('createExecutorWorker', () => {
    it('creates worker with default registry when none provided', async () => {
      const storage = createMockStorage();
      const config: ExecutorFactoryConfig = {
        env: makeEnv(),
        storage,
        mode: 'NORMAL',
      };

      const result = await createExecutorWorker(config);

      expect(result.worker).toBeDefined();
      expect(result.specialistIds.length).toBeGreaterThan(0);
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.specialistIds)).toBe(true);
    });

    it('creates worker with custom registry', async () => {
      const storage = createMockStorage();
      const config: ExecutorFactoryConfig = {
        env: makeEnv(),
        storage,
        mode: 'NORMAL',
        registry: makeRegistry(),
      };

      const result = await createExecutorWorker(config);

      expect(result.specialistIds).toContain('codex');
      expect(result.specialistIds).toContain('glm');
      expect(result.specialistIds).toHaveLength(2);
    });

    it('loads per-specialist CB states from storage', async () => {
      const cbState: CircuitBreakerState = Object.freeze({
        state: 'HALF_OPEN',
        consecutiveFailures: 3,
        lastFailureMs: 1000,
        totalFailures: 5,
        totalSuccesses: 10,
      });
      const storage = createMockStorage({
        'autopilot:cb:v2:codex': cbState,
      });
      const config: ExecutorFactoryConfig = {
        env: makeEnv(),
        storage,
        mode: 'NORMAL',
        registry: makeRegistry(),
      };

      await createExecutorWorker(config);

      // Should have loaded CB for both specialists
      expect(storage.get).toHaveBeenCalled();
    });

    it('creates default CB state when storage has no entry', async () => {
      const storage = createMockStorage(); // empty
      const config: ExecutorFactoryConfig = {
        env: makeEnv(),
        storage,
        mode: 'NORMAL',
        registry: makeRegistry(),
      };

      const result = await createExecutorWorker(config);

      // Worker should still be created successfully
      expect(result.worker).toBeDefined();
    });

    it('loads weekly counts from storage', async () => {
      const isoWeek = currentIsoWeek();
      const storage = createMockStorage({
        [`autopilot:weekly:v1:codex:${isoWeek}`]: 42,
      });
      const config: ExecutorFactoryConfig = {
        env: makeEnv(),
        storage,
        mode: 'NORMAL',
        registry: makeRegistry(),
      };

      await createExecutorWorker(config);

      expect(storage.get).toHaveBeenCalled();
    });

    it('excludes disabled specialists from specialistIds', async () => {
      const registry: SpecialistRegistry = Object.freeze({
        specialists: Object.freeze([
          Object.freeze({ id: 'codex', name: 'Codex', trustLevel: 'TRUSTED', maxRiskTier: 4, enabled: true } as SpecialistConfig),
          Object.freeze({ id: 'grok', name: 'Grok', trustLevel: 'UNTRUSTED', maxRiskTier: 1, enabled: false } as SpecialistConfig),
        ]),
      });
      const storage = createMockStorage();
      const config: ExecutorFactoryConfig = {
        env: makeEnv(),
        storage,
        mode: 'NORMAL',
        registry,
      };

      const result = await createExecutorWorker(config);

      expect(result.specialistIds).toContain('codex');
      expect(result.specialistIds).not.toContain('grok');
    });
  });

  describe('incrementWeeklyCount', () => {
    it('increments from 0 when no stored value', async () => {
      const storage = createMockStorage();

      await incrementWeeklyCount(storage, 'codex', '2026-W07');

      expect(storage.put).toHaveBeenCalledWith({
        'autopilot:weekly:v1:codex:2026-W07': 1,
      });
    });

    it('increments existing value', async () => {
      const storage = createMockStorage({
        'autopilot:weekly:v1:codex:2026-W07': 5,
      });

      await incrementWeeklyCount(storage, 'codex', '2026-W07');

      expect(storage.put).toHaveBeenCalledWith({
        'autopilot:weekly:v1:codex:2026-W07': 6,
      });
    });

    it('uses current week when isoWeek not provided', async () => {
      const storage = createMockStorage();

      await incrementWeeklyCount(storage, 'glm');

      const expectedKey = `autopilot:weekly:v1:glm:${currentIsoWeek()}`;
      expect(storage.put).toHaveBeenCalledWith({
        [expectedKey]: 1,
      });
    });
  });
});
