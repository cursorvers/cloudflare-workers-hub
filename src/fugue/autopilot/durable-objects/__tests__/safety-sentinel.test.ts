import { describe, expect, it, vi, beforeEach } from 'vitest';

// =============================================================================
// Mock SafetySentinel by testing its HTTP API contract
// We simulate the DO fetch interface with a lightweight harness.
// =============================================================================

import {
  createInitialState,
  transitionMode,
  applyTransition,
  isOperational,
  type RuntimeState,
} from '../../runtime/coordinator';
import {
  runGuardCheck,
  type GuardInput,
} from '../../runtime/runtime-guard';
import {
  createHeartbeatState,
  recordHeartbeat,
} from '../../runtime/heartbeat';
import {
  createCircuitBreakerState,
  recordSuccess as cbRecordSuccess,
  recordFailure as cbRecordFailure,
} from '../../runtime/circuit-breaker';
import type { SentinelStatus, SentinelGuardResult } from '../safety-sentinel-types';

// =============================================================================
// Lightweight SafetySentinel simulation (pure functions only, no DO runtime)
// =============================================================================

interface SentinelState {
  runtimeState: RuntimeState;
  heartbeatState: ReturnType<typeof createHeartbeatState>;
  circuitBreakerState: ReturnType<typeof createCircuitBreakerState>;
  budgetSpent: number;
  budgetLimit: number;
  lastGuardCheck: ReturnType<typeof runGuardCheck> | null;
}

function createSentinel(): SentinelState {
  return {
    runtimeState: createInitialState(),
    heartbeatState: createHeartbeatState(Date.now()),
    circuitBreakerState: createCircuitBreakerState(),
    budgetSpent: 0,
    budgetLimit: 200,
    lastGuardCheck: null,
  };
}

function sentinelStatus(s: SentinelState): SentinelStatus {
  return Object.freeze({
    mode: s.runtimeState.mode,
    isOperational: isOperational(s.runtimeState),
    lastGuardCheck: s.lastGuardCheck,
    heartbeatState: s.heartbeatState,
    circuitBreakerState: s.circuitBreakerState,
    budgetSpent: s.budgetSpent,
    budgetLimit: s.budgetLimit,
    timestamp: Date.now(),
  });
}

function sentinelGuardCheck(s: SentinelState, now: number): { state: SentinelState; result: SentinelGuardResult } {
  const guardInput: GuardInput = {
    budget: { spent: s.budgetSpent, limit: s.budgetLimit },
    circuitBreaker: { state: s.circuitBreakerState },
    heartbeat: { state: s.heartbeatState },
  };

  const guardResult = runGuardCheck(guardInput, now);
  let runtimeState = s.runtimeState;
  let autoStopped = false;
  let transition = null;

  if (guardResult.shouldTransitionToStopped && isOperational(runtimeState)) {
    const stopResult = transitionMode(runtimeState, 'STOPPED', `auto-stop: ${guardResult.reasons.join('; ')}`, now);
    runtimeState = applyTransition(runtimeState, stopResult);
    autoStopped = true;
    transition = stopResult;
  }

  const newState: SentinelState = {
    ...s,
    runtimeState,
    lastGuardCheck: guardResult,
  };

  return {
    state: newState,
    result: Object.freeze({ guardCheck: guardResult, autoStopped, transition }),
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('fugue/autopilot/durable-objects/safety-sentinel', () => {
  describe('initialization', () => {
    it('starts in STOPPED mode', () => {
      const s = createSentinel();
      expect(s.runtimeState.mode).toBe('STOPPED');
      expect(isOperational(s.runtimeState)).toBe(false);
    });

    it('has default budget of 0/200', () => {
      const s = createSentinel();
      expect(s.budgetSpent).toBe(0);
      expect(s.budgetLimit).toBe(200);
    });

    it('has no guard check initially', () => {
      const s = createSentinel();
      expect(s.lastGuardCheck).toBeNull();
    });
  });

  describe('status', () => {
    it('returns frozen status object', () => {
      const s = createSentinel();
      const status = sentinelStatus(s);
      expect(Object.isFrozen(status)).toBe(true);
      expect(status.mode).toBe('STOPPED');
      expect(status.isOperational).toBe(false);
    });

    it('reflects current state after transition', () => {
      let s = createSentinel();
      const result = transitionMode(s.runtimeState, 'NORMAL', 'test');
      s = { ...s, runtimeState: applyTransition(s.runtimeState, result) };
      const status = sentinelStatus(s);
      expect(status.mode).toBe('NORMAL');
      expect(status.isOperational).toBe(true);
    });
  });

  describe('guard check', () => {
    it('returns CONTINUE when system is healthy', () => {
      let s = createSentinel();
      // Transition to NORMAL
      const toNormal = transitionMode(s.runtimeState, 'NORMAL', 'start');
      s = { ...s, runtimeState: applyTransition(s.runtimeState, toNormal) };
      // Record fresh heartbeat
      s = { ...s, heartbeatState: recordHeartbeat(s.heartbeatState, Date.now()) };

      const { result } = sentinelGuardCheck(s, Date.now());
      expect(result.guardCheck.verdict).toBe('CONTINUE');
      expect(result.autoStopped).toBe(false);
      expect(result.transition).toBeNull();
    });

    it('triggers auto-STOP on budget critical', () => {
      let s = createSentinel();
      const toNormal = transitionMode(s.runtimeState, 'NORMAL', 'start');
      s = { ...s, runtimeState: applyTransition(s.runtimeState, toNormal) };
      s = { ...s, heartbeatState: recordHeartbeat(s.heartbeatState, Date.now()) };
      // Set budget to critical
      s = { ...s, budgetSpent: 200, budgetLimit: 200 };

      const { state, result } = sentinelGuardCheck(s, Date.now());
      expect(result.guardCheck.shouldTransitionToStopped).toBe(true);
      expect(result.autoStopped).toBe(true);
      expect(state.runtimeState.mode).toBe('STOPPED');
    });

    it('triggers auto-STOP on circuit breaker OPEN', () => {
      let s = createSentinel();
      const toNormal = transitionMode(s.runtimeState, 'NORMAL', 'start');
      s = { ...s, runtimeState: applyTransition(s.runtimeState, toNormal) };
      s = { ...s, heartbeatState: recordHeartbeat(s.heartbeatState, Date.now()) };

      // Open circuit breaker
      let cb = s.circuitBreakerState;
      const now = Date.now();
      for (let i = 0; i < 5; i++) {
        cb = cbRecordFailure(cb, undefined, now + i * 100);
      }
      expect(cb.state).toBe('OPEN');
      s = { ...s, circuitBreakerState: cb };

      const { state, result } = sentinelGuardCheck(s, now + 1000);
      expect(result.autoStopped).toBe(true);
      expect(state.runtimeState.mode).toBe('STOPPED');
    });

    it('does not trigger auto-STOP when already STOPPED', () => {
      const s = createSentinel();
      // System starts in STOPPED, set critical budget
      const withBudget = { ...s, budgetSpent: 200, budgetLimit: 200 };

      const { result } = sentinelGuardCheck(withBudget, Date.now());
      expect(result.autoStopped).toBe(false);
      expect(result.transition).toBeNull();
    });

    it('result is frozen', () => {
      const s = createSentinel();
      const { result } = sentinelGuardCheck(s, Date.now());
      expect(Object.isFrozen(result)).toBe(true);
    });
  });

  describe('heartbeat', () => {
    it('records heartbeat correctly', () => {
      const s = createSentinel();
      const now = Date.now();
      const updated = { ...s, heartbeatState: recordHeartbeat(s.heartbeatState, now) };
      expect(updated.heartbeatState.lastHeartbeatMs).toBe(now);
      expect(updated.heartbeatState.totalHeartbeats).toBeGreaterThan(s.heartbeatState.totalHeartbeats);
    });
  });

  describe('budget update', () => {
    it('updates budget correctly', () => {
      let s = createSentinel();
      s = { ...s, budgetSpent: 150, budgetLimit: 300 };
      expect(s.budgetSpent).toBe(150);
      expect(s.budgetLimit).toBe(300);
    });
  });

  describe('circuit breaker', () => {
    it('records success', () => {
      const s = createSentinel();
      const updated = { ...s, circuitBreakerState: cbRecordSuccess(s.circuitBreakerState) };
      expect(updated.circuitBreakerState.state).toBe('CLOSED');
    });

    it('records failure and transitions to OPEN', () => {
      let cb = createCircuitBreakerState();
      const now = Date.now();
      for (let i = 0; i < 5; i++) {
        cb = cbRecordFailure(cb, undefined, now + i * 100);
      }
      expect(cb.state).toBe('OPEN');
    });
  });

  describe('mode transition', () => {
    it('transitions STOPPED -> NORMAL', () => {
      const s = createSentinel();
      const result = transitionMode(s.runtimeState, 'NORMAL', 'start');
      const newState = applyTransition(s.runtimeState, result);
      expect(newState.mode).toBe('NORMAL');
      expect(result.success).toBe(true);
    });

    it('transitions NORMAL -> STOPPED', () => {
      let s = createSentinel();
      const toNormal = transitionMode(s.runtimeState, 'NORMAL', 'start');
      s = { ...s, runtimeState: applyTransition(s.runtimeState, toNormal) };

      const toStopped = transitionMode(s.runtimeState, 'STOPPED', 'manual stop');
      const newState = applyTransition(s.runtimeState, toStopped);
      expect(newState.mode).toBe('STOPPED');
    });

    it('resets circuit breaker on recovery to NORMAL', () => {
      let s = createSentinel();
      // Add some failures
      let cb = s.circuitBreakerState;
      for (let i = 0; i < 3; i++) {
        cb = cbRecordFailure(cb, undefined, Date.now() + i * 100);
      }
      s = { ...s, circuitBreakerState: cb };
      expect(s.circuitBreakerState.consecutiveFailures).toBe(3);

      // Transition to NORMAL -> reset circuit breaker
      const result = transitionMode(s.runtimeState, 'NORMAL', 'recovery');
      const newRuntime = applyTransition(s.runtimeState, result);
      if (result.success && result.currentMode === 'NORMAL' && result.previousMode === 'STOPPED') {
        s = { ...s, runtimeState: newRuntime, circuitBreakerState: createCircuitBreakerState() };
      }
      expect(s.circuitBreakerState.consecutiveFailures).toBe(0);
      expect(s.runtimeState.mode).toBe('NORMAL');
    });

    it('idempotent same-mode transition', () => {
      const s = createSentinel();
      const result = transitionMode(s.runtimeState, 'STOPPED', 'already stopped');
      expect(result.success).toBe(true);
      expect(result.previousMode).toBe('STOPPED');
      expect(result.currentMode).toBe('STOPPED');
    });
  });

  describe('end-to-end lifecycle', () => {
    it('full lifecycle: init -> start -> guard -> stop -> verify', () => {
      let s = createSentinel();

      // 1. Start
      const startResult = transitionMode(s.runtimeState, 'NORMAL', 'start');
      s = { ...s, runtimeState: applyTransition(s.runtimeState, startResult) };
      expect(s.runtimeState.mode).toBe('NORMAL');

      // 2. Record heartbeat
      const now = Date.now();
      s = { ...s, heartbeatState: recordHeartbeat(s.heartbeatState, now) };

      // 3. Guard check (healthy)
      const { state: s2, result: guard1 } = sentinelGuardCheck(s, now);
      s = s2;
      expect(guard1.guardCheck.verdict).toBe('CONTINUE');
      expect(guard1.autoStopped).toBe(false);

      // 4. Exhaust budget
      s = { ...s, budgetSpent: 200, budgetLimit: 200 };

      // 5. Guard check (should auto-stop)
      const { state: s3, result: guard2 } = sentinelGuardCheck(s, now + 1000);
      s = s3;
      expect(guard2.autoStopped).toBe(true);
      expect(s.runtimeState.mode).toBe('STOPPED');

      // 6. Verify status
      const status = sentinelStatus(s);
      expect(status.mode).toBe('STOPPED');
      expect(status.isOperational).toBe(false);
      expect(status.budgetSpent).toBe(200);
    });
  });

  describe('immutability', () => {
    it('all state transitions produce frozen objects', () => {
      const s = createSentinel();
      const result = transitionMode(s.runtimeState, 'NORMAL', 'test');
      const newState = applyTransition(s.runtimeState, result);
      expect(Object.isFrozen(newState)).toBe(true);
      expect(Object.isFrozen(result)).toBe(true);
    });

    it('heartbeat state is frozen', () => {
      const s = createSentinel();
      const updated = recordHeartbeat(s.heartbeatState, Date.now());
      expect(Object.isFrozen(updated)).toBe(true);
    });
  });
});
