import { describe, expect, it } from 'vitest';

import {
  applyTransition,
  createInitialState,
  isOperational,
  transitionMode,
  // Extended mode exports
  createInitialExtendedState,
  applyExtendedTransition,
  transitionExtendedMode,
  isExtendedOperational,
  isExtendedStateOperational,
  toLegacyMode,
  isModeHealthy,
  checkModeTimeout,
  DEFAULT_TRANSITION_POLICY,
  type ExtendedRuntimeState,
} from '../coordinator';

describe('runtime/coordinator', () => {
  it('初期状態がSTOPPED', () => {
    const state = createInitialState();
    expect(state.mode).toBe('STOPPED');
    expect(state.lastTransition).toBeNull();
    expect(state.transitionCount).toBe(0);
  });

  it('STOPPED→NORMAL遷移成功', () => {
    const state = createInitialState();
    const result = transitionMode(state, 'NORMAL', 'resume', 1000);
    const next = applyTransition(state, result);

    expect(result.success).toBe(true);
    expect(result.previousMode).toBe('STOPPED');
    expect(result.currentMode).toBe('NORMAL');
    expect(next.mode).toBe('NORMAL');
  });

  it('NORMAL→STOPPED遷移成功', () => {
    const stopped = createInitialState();
    const toNormal = transitionMode(stopped, 'NORMAL', 'resume', 1000);
    const normal = applyTransition(stopped, toNormal);

    const toStopped = transitionMode(normal, 'STOPPED', 'manual-stop', 2000);
    const next = applyTransition(normal, toStopped);

    expect(toStopped.success).toBe(true);
    expect(toStopped.previousMode).toBe('NORMAL');
    expect(toStopped.currentMode).toBe('STOPPED');
    expect(next.mode).toBe('STOPPED');
  });

  it('同じモードへの遷移（冪等: 成功扱い）', () => {
    const state = createInitialState();
    const result = transitionMode(state, 'STOPPED', 'already stopped', 3000);
    const next = applyTransition(state, result);

    expect(result.success).toBe(true);
    expect(result.previousMode).toBe('STOPPED');
    expect(result.currentMode).toBe('STOPPED');
    expect(result.reason).toContain('idempotent no-op');
    expect(next.mode).toBe('STOPPED');
  });

  it('遷移結果にtimestamp含む', () => {
    const state = createInitialState();
    const result = transitionMode(state, 'NORMAL', 'resume', 123456789);
    expect(result.timestamp).toBe(123456789);
  });

  it('applyTransitionで新しい状態生成（不変性）', () => {
    const prev = createInitialState();
    const result = transitionMode(prev, 'NORMAL', 'resume', 1000);
    const next = applyTransition(prev, result);

    expect(next).not.toBe(prev);
    expect(prev.mode).toBe('STOPPED');
    expect(next.mode).toBe('NORMAL');
    expect(next.lastTransition).toEqual(result);
    expect(next.transitionCount).toBe(prev.transitionCount + 1);
  });

  it('isOperational: NORMALでtrue、STOPPEDでfalse', () => {
    const stopped = createInitialState();
    const toNormal = transitionMode(stopped, 'NORMAL', 'resume', 1000);
    const normal = applyTransition(stopped, toNormal);

    expect(isOperational(normal)).toBe(true);
    expect(isOperational(stopped)).toBe(false);
  });

  it('全結果がObject.freeze', () => {
    const initial = createInitialState();
    const result = transitionMode(initial, 'NORMAL', 'resume', 1000);
    const next = applyTransition(initial, result);

    expect(Object.isFrozen(initial)).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(next)).toBe(true);
    expect(next.lastTransition).not.toBeNull();
    expect(Object.isFrozen(next.lastTransition)).toBe(true);
  });
});

// =============================================================================
// Extended Mode Tests (Phase 3)
// =============================================================================

describe('runtime/coordinator (extended mode)', () => {
  describe('toLegacyMode', () => {
    it('NORMAL -> NORMAL', () => {
      expect(toLegacyMode('NORMAL')).toBe('NORMAL');
    });

    it('DEGRADED -> NORMAL (operational)', () => {
      expect(toLegacyMode('DEGRADED')).toBe('NORMAL');
    });

    it('RECOVERY -> STOPPED (not operational)', () => {
      expect(toLegacyMode('RECOVERY')).toBe('STOPPED');
    });

    it('STOPPED -> STOPPED', () => {
      expect(toLegacyMode('STOPPED')).toBe('STOPPED');
    });
  });

  describe('isExtendedOperational', () => {
    it('NORMAL is operational', () => {
      expect(isExtendedOperational('NORMAL')).toBe(true);
    });

    it('DEGRADED is operational', () => {
      expect(isExtendedOperational('DEGRADED')).toBe(true);
    });

    it('RECOVERY is not operational', () => {
      expect(isExtendedOperational('RECOVERY')).toBe(false);
    });

    it('STOPPED is not operational', () => {
      expect(isExtendedOperational('STOPPED')).toBe(false);
    });
  });

  describe('createInitialExtendedState', () => {
    it('starts in STOPPED', () => {
      const state = createInitialExtendedState(1000);
      expect(state.mode).toBe('STOPPED');
      expect(state.previousMode).toBeNull();
      expect(state.lastTransition).toBeNull();
      expect(state.transitionCount).toBe(0);
      expect(state.enteredCurrentModeAt).toBe(1000);
    });

    it('is frozen', () => {
      const state = createInitialExtendedState();
      expect(Object.isFrozen(state)).toBe(true);
    });
  });

  describe('applyExtendedTransition', () => {
    it('STOPPED -> RECOVERY', () => {
      const state = createInitialExtendedState(1000);
      const next = applyExtendedTransition(state, 'RECOVERY', 'auto-recovery', 2000);
      expect(next.mode).toBe('RECOVERY');
      expect(next.previousMode).toBe('STOPPED');
      expect(next.enteredCurrentModeAt).toBe(2000);
    });

    it('STOPPED -> NORMAL (direct start)', () => {
      const state = createInitialExtendedState(1000);
      const next = applyExtendedTransition(state, 'NORMAL', 'direct start', 2000);
      expect(next.mode).toBe('NORMAL');
    });

    it('RECOVERY -> NORMAL', () => {
      const state = createInitialExtendedState(1000);
      const inRecovery = applyExtendedTransition(state, 'RECOVERY', 'recovery', 2000);
      const normal = applyExtendedTransition(inRecovery, 'NORMAL', 'recovered', 3000);
      expect(normal.mode).toBe('NORMAL');
      expect(normal.previousMode).toBe('RECOVERY');
    });

    it('NORMAL -> DEGRADED', () => {
      const state = createInitialExtendedState(1000);
      const normal = applyExtendedTransition(state, 'NORMAL', 'start', 2000);
      const degraded = applyExtendedTransition(normal, 'DEGRADED', 'budget warning', 3000);
      expect(degraded.mode).toBe('DEGRADED');
      expect(degraded.previousMode).toBe('NORMAL');
    });

    it('DEGRADED -> NORMAL (resolved)', () => {
      const state = createInitialExtendedState(1000);
      const normal = applyExtendedTransition(state, 'NORMAL', 'start', 2000);
      const degraded = applyExtendedTransition(normal, 'DEGRADED', 'warning', 3000);
      const resolved = applyExtendedTransition(degraded, 'NORMAL', 'resolved', 4000);
      expect(resolved.mode).toBe('NORMAL');
    });

    it('DEGRADED -> STOPPED', () => {
      const state = createInitialExtendedState(1000);
      const normal = applyExtendedTransition(state, 'NORMAL', 'start', 2000);
      const degraded = applyExtendedTransition(normal, 'DEGRADED', 'warning', 3000);
      const stopped = applyExtendedTransition(degraded, 'STOPPED', 'critical', 4000);
      expect(stopped.mode).toBe('STOPPED');
    });

    it('invalid transition fails closed to STOPPED', () => {
      const state = createInitialExtendedState(1000);
      const normal = applyExtendedTransition(state, 'NORMAL', 'start', 2000);
      // NORMAL -> RECOVERY is invalid
      const result = applyExtendedTransition(normal, 'RECOVERY', 'invalid', 3000);
      expect(result.mode).toBe('STOPPED');
    });

    it('transition count increments', () => {
      let state = createInitialExtendedState(1000);
      expect(state.transitionCount).toBe(0);
      state = applyExtendedTransition(state, 'NORMAL', 'start', 2000);
      expect(state.transitionCount).toBe(1);
      state = applyExtendedTransition(state, 'DEGRADED', 'warn', 3000);
      expect(state.transitionCount).toBe(2);
    });

    it('all results are frozen', () => {
      const state = createInitialExtendedState(1000);
      const next = applyExtendedTransition(state, 'NORMAL', 'start', 2000);
      expect(Object.isFrozen(next)).toBe(true);
      expect(Object.isFrozen(next.lastTransition)).toBe(true);
    });
  });

  describe('transitionExtendedMode (legacy result format)', () => {
    it('maps DEGRADED to legacy NORMAL', () => {
      const state = createInitialExtendedState(1000);
      const normal = applyExtendedTransition(state, 'NORMAL', 'start', 2000);
      const result = transitionExtendedMode(normal, 'DEGRADED', 'budget warning', 3000);
      expect(result.success).toBe(true);
      // Legacy format: DEGRADED maps to NORMAL
      expect(result.currentMode).toBe('NORMAL');
    });

    it('maps RECOVERY to legacy STOPPED', () => {
      const state = createInitialExtendedState(1000);
      const result = transitionExtendedMode(state, 'RECOVERY', 'auto-recovery', 2000);
      expect(result.success).toBe(true);
      // Legacy format: RECOVERY maps to STOPPED
      expect(result.currentMode).toBe('STOPPED');
    });
  });

  describe('isExtendedStateOperational', () => {
    it('NORMAL state is operational', () => {
      const state = createInitialExtendedState(1000);
      const normal = applyExtendedTransition(state, 'NORMAL', 'start', 2000);
      expect(isExtendedStateOperational(normal)).toBe(true);
    });

    it('DEGRADED state is operational', () => {
      const state = createInitialExtendedState(1000);
      const normal = applyExtendedTransition(state, 'NORMAL', 'start', 2000);
      const degraded = applyExtendedTransition(normal, 'DEGRADED', 'warn', 3000);
      expect(isExtendedStateOperational(degraded)).toBe(true);
    });

    it('STOPPED state is not operational', () => {
      const state = createInitialExtendedState(1000);
      expect(isExtendedStateOperational(state)).toBe(false);
    });

    it('RECOVERY state is not operational', () => {
      const state = createInitialExtendedState(1000);
      const recovery = applyExtendedTransition(state, 'RECOVERY', 'recover', 2000);
      expect(isExtendedStateOperational(recovery)).toBe(false);
    });
  });

  describe('full extended lifecycle', () => {
    it('STOPPED -> RECOVERY -> NORMAL -> DEGRADED -> STOPPED', () => {
      let state = createInitialExtendedState(1000);
      expect(state.mode).toBe('STOPPED');

      state = applyExtendedTransition(state, 'RECOVERY', 'auto-recovery', 2000);
      expect(state.mode).toBe('RECOVERY');

      state = applyExtendedTransition(state, 'NORMAL', 'recovery complete', 3000);
      expect(state.mode).toBe('NORMAL');

      state = applyExtendedTransition(state, 'DEGRADED', 'budget warning', 4000);
      expect(state.mode).toBe('DEGRADED');

      state = applyExtendedTransition(state, 'STOPPED', 'budget critical', 5000);
      expect(state.mode).toBe('STOPPED');
      expect(state.transitionCount).toBe(4);
    });
  });
});
