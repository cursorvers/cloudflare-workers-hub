import { describe, expect, it } from 'vitest';

import {
  reconcileState,
  type ReconciliationInput,
} from '../reconciliation';

// =============================================================================
// Helpers
// =============================================================================

function makeExtendedState(mode: string, transitionCount: number) {
  return {
    mode: mode as 'NORMAL' | 'DEGRADED' | 'RECOVERY' | 'STOPPED',
    previousMode: null,
    lastTransition: null,
    transitionCount,
    enteredCurrentModeAt: Date.now(),
  };
}

function makeHeartbeat(lastHeartbeat: number) {
  return { lastHeartbeat, count: 1 };
}

function makeBudget(spent: number, limit: number, updatedAt: number) {
  return { spent, limit, updatedAt };
}

function makeCircuitBreaker() {
  return {
    state: 'CLOSED' as const,
    failureCount: 0,
    successCount: 0,
    lastFailure: null,
    lastSuccess: null,
    openedAt: null,
    halfOpenAt: null,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('Phase 5b: state reconciliation', () => {
  describe('reconcileState', () => {
    it('returns no drift when states match', () => {
      const ext = makeExtendedState('NORMAL', 5);
      const hb = makeHeartbeat(1000);
      const budget = makeBudget(50, 200, 1000);
      const cb = makeCircuitBreaker();

      const input: ReconciliationInput = {
        inMemory: { extendedState: ext, heartbeat: hb, circuitBreaker: cb, budget },
        persisted: { extendedState: ext, heartbeat: hb, circuitBreaker: cb, budget },
        nowMs: Date.now(),
      };

      const result = reconcileState(input);
      expect(result.hasDrift).toBe(false);
      expect(result.repairs).toHaveLength(0);
    });

    it('detects extended state drift — prefers higher transitionCount', () => {
      const memState = makeExtendedState('NORMAL', 3);
      const diskState = makeExtendedState('DEGRADED', 5);
      const hb = makeHeartbeat(1000);
      const budget = makeBudget(50, 200, 1000);
      const cb = makeCircuitBreaker();

      const result = reconcileState({
        inMemory: { extendedState: memState, heartbeat: hb, circuitBreaker: cb, budget },
        persisted: { extendedState: diskState, heartbeat: hb, circuitBreaker: cb, budget },
        nowMs: Date.now(),
      });

      expect(result.hasDrift).toBe(true);
      expect(result.repairs).toContain('extendedState');
      expect(result.repairedState.extendedState.mode).toBe('DEGRADED');
    });

    it('keeps in-memory state when transitionCount is higher', () => {
      const memState = makeExtendedState('NORMAL', 10);
      const diskState = makeExtendedState('STOPPED', 5);
      const hb = makeHeartbeat(1000);
      const budget = makeBudget(50, 200, 1000);
      const cb = makeCircuitBreaker();

      const result = reconcileState({
        inMemory: { extendedState: memState, heartbeat: hb, circuitBreaker: cb, budget },
        persisted: { extendedState: diskState, heartbeat: hb, circuitBreaker: cb, budget },
        nowMs: Date.now(),
      });

      expect(result.repairedState.extendedState.mode).toBe('NORMAL');
      expect(result.repairs).not.toContain('extendedState');
    });

    it('detects heartbeat drift — prefers more recent', () => {
      const ext = makeExtendedState('NORMAL', 5);
      const memHb = makeHeartbeat(1000);
      const diskHb = makeHeartbeat(2000);
      const budget = makeBudget(50, 200, 1000);
      const cb = makeCircuitBreaker();

      const result = reconcileState({
        inMemory: { extendedState: ext, heartbeat: memHb, circuitBreaker: cb, budget },
        persisted: { extendedState: ext, heartbeat: diskHb, circuitBreaker: cb, budget },
        nowMs: Date.now(),
      });

      expect(result.hasDrift).toBe(true);
      expect(result.repairs).toContain('heartbeat');
      expect(result.repairedState.heartbeat.lastHeartbeat).toBe(2000);
    });

    it('circuit breaker always keeps in-memory (authoritative)', () => {
      const ext = makeExtendedState('NORMAL', 5);
      const hb = makeHeartbeat(1000);
      const budget = makeBudget(50, 200, 1000);
      const memCb = makeCircuitBreaker();
      const diskCb = { ...makeCircuitBreaker(), failureCount: 999 };

      const result = reconcileState({
        inMemory: { extendedState: ext, heartbeat: hb, circuitBreaker: memCb, budget },
        persisted: { extendedState: ext, heartbeat: hb, circuitBreaker: diskCb, budget },
        nowMs: Date.now(),
      });

      expect(result.repairedState.circuitBreaker).toBe(memCb);
    });

    it('detects budget drift — prefers more recent updatedAt', () => {
      const ext = makeExtendedState('NORMAL', 5);
      const hb = makeHeartbeat(1000);
      const memBudget = makeBudget(50, 200, 1000);
      const diskBudget = makeBudget(100, 200, 2000);
      const cb = makeCircuitBreaker();

      const result = reconcileState({
        inMemory: { extendedState: ext, heartbeat: hb, circuitBreaker: cb, budget: memBudget },
        persisted: { extendedState: ext, heartbeat: hb, circuitBreaker: cb, budget: diskBudget },
        nowMs: Date.now(),
      });

      expect(result.hasDrift).toBe(true);
      expect(result.repairs).toContain('budget');
      expect(result.repairedState.budget.spent).toBe(100);
    });

    it('handles missing persisted state gracefully', () => {
      const ext = makeExtendedState('NORMAL', 5);
      const hb = makeHeartbeat(1000);
      const budget = makeBudget(50, 200, 1000);
      const cb = makeCircuitBreaker();

      const result = reconcileState({
        inMemory: { extendedState: ext, heartbeat: hb, circuitBreaker: cb, budget },
        persisted: { extendedState: undefined, heartbeat: undefined, circuitBreaker: undefined, budget: undefined },
        nowMs: Date.now(),
      });

      // Should keep all in-memory values
      expect(result.repairedState.extendedState.mode).toBe('NORMAL');
      expect(result.repairedState.heartbeat.lastHeartbeat).toBe(1000);
      expect(result.repairedState.budget.spent).toBe(50);
    });

    it('result is frozen (immutability)', () => {
      const ext = makeExtendedState('NORMAL', 5);
      const hb = makeHeartbeat(1000);
      const budget = makeBudget(50, 200, 1000);
      const cb = makeCircuitBreaker();

      const result = reconcileState({
        inMemory: { extendedState: ext, heartbeat: hb, circuitBreaker: cb, budget },
        persisted: { extendedState: ext, heartbeat: hb, circuitBreaker: cb, budget },
        nowMs: Date.now(),
      });

      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.drifts)).toBe(true);
      expect(Object.isFrozen(result.repairedState)).toBe(true);
    });
  });
});
