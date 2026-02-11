import { describe, expect, it } from 'vitest';

import {
  EXTENDED_MODES,
  DEFAULT_TRANSITION_POLICY,
  createInitialModeState,
  isValidTransition,
  getValidTargets,
  attemptTransition,
  applyModeTransition,
  checkModeTimeout,
  isModeOperational,
  isModeHealthy,
  type ExtendedMode,
  type ModeState,
} from '../mode-machine';

// =============================================================================
// Helpers
// =============================================================================

function stateInMode(mode: ExtendedMode, enteredAt = 1000): ModeState {
  return Object.freeze({
    mode,
    previousMode: null,
    lastTransition: null,
    transitionCount: 0,
    enteredCurrentModeAt: enteredAt,
  });
}

function transitionTo(state: ModeState, target: ExtendedMode, reason: string, now?: number): ModeState {
  const t = attemptTransition(state, target, reason, now);
  return applyModeTransition(state, t);
}

// =============================================================================
// Tests
// =============================================================================

describe('fugue/autopilot/runtime/mode-machine', () => {
  describe('constants', () => {
    it('EXTENDED_MODES has 4 modes', () => {
      expect(EXTENDED_MODES).toHaveLength(4);
      expect(EXTENDED_MODES).toContain('NORMAL');
      expect(EXTENDED_MODES).toContain('DEGRADED');
      expect(EXTENDED_MODES).toContain('RECOVERY');
      expect(EXTENDED_MODES).toContain('STOPPED');
    });

    it('DEFAULT_TRANSITION_POLICY is frozen', () => {
      expect(Object.isFrozen(DEFAULT_TRANSITION_POLICY)).toBe(true);
      expect(DEFAULT_TRANSITION_POLICY.maxRecoveryDurationMs).toBe(300_000);
      expect(DEFAULT_TRANSITION_POLICY.maxDegradedDurationMs).toBe(600_000);
      expect(DEFAULT_TRANSITION_POLICY.autoRecoveryEnabled).toBe(true);
    });
  });

  describe('createInitialModeState', () => {
    it('starts in STOPPED mode', () => {
      const state = createInitialModeState(1000);
      expect(state.mode).toBe('STOPPED');
      expect(state.previousMode).toBeNull();
      expect(state.lastTransition).toBeNull();
      expect(state.transitionCount).toBe(0);
      expect(state.enteredCurrentModeAt).toBe(1000);
    });

    it('is frozen', () => {
      const state = createInitialModeState();
      expect(Object.isFrozen(state)).toBe(true);
    });
  });

  describe('isValidTransition', () => {
    it('allows STOPPED -> RECOVERY', () => {
      expect(isValidTransition('STOPPED', 'RECOVERY')).toBe(true);
    });

    it('allows STOPPED -> NORMAL (direct start)', () => {
      expect(isValidTransition('STOPPED', 'NORMAL')).toBe(true);
    });

    it('allows RECOVERY -> NORMAL', () => {
      expect(isValidTransition('RECOVERY', 'NORMAL')).toBe(true);
    });

    it('allows RECOVERY -> STOPPED', () => {
      expect(isValidTransition('RECOVERY', 'STOPPED')).toBe(true);
    });

    it('allows NORMAL -> DEGRADED', () => {
      expect(isValidTransition('NORMAL', 'DEGRADED')).toBe(true);
    });

    it('allows NORMAL -> STOPPED', () => {
      expect(isValidTransition('NORMAL', 'STOPPED')).toBe(true);
    });

    it('allows DEGRADED -> NORMAL', () => {
      expect(isValidTransition('DEGRADED', 'NORMAL')).toBe(true);
    });

    it('allows DEGRADED -> STOPPED', () => {
      expect(isValidTransition('DEGRADED', 'STOPPED')).toBe(true);
    });

    it('rejects NORMAL -> RECOVERY (skip)', () => {
      expect(isValidTransition('NORMAL', 'RECOVERY')).toBe(false);
    });

    it('rejects STOPPED -> DEGRADED (must go through RECOVERY or NORMAL)', () => {
      expect(isValidTransition('STOPPED', 'DEGRADED')).toBe(false);
    });

    it('emergency STOP always allowed from any state', () => {
      for (const mode of EXTENDED_MODES) {
        expect(isValidTransition(mode, 'STOPPED')).toBe(true);
      }
    });
  });

  describe('getValidTargets', () => {
    it('STOPPED can go to RECOVERY or NORMAL', () => {
      const targets = getValidTargets('STOPPED');
      expect(targets).toContain('RECOVERY');
      expect(targets).toContain('NORMAL');
    });

    it('NORMAL can go to DEGRADED or STOPPED', () => {
      const targets = getValidTargets('NORMAL');
      expect(targets).toContain('DEGRADED');
      expect(targets).toContain('STOPPED');
    });

    it('results are frozen', () => {
      const targets = getValidTargets('STOPPED');
      expect(Object.isFrozen(targets)).toBe(true);
    });
  });

  describe('attemptTransition', () => {
    it('succeeds for valid transition', () => {
      const state = stateInMode('STOPPED');
      const t = attemptTransition(state, 'NORMAL', 'start', 2000);
      expect(t.success).toBe(true);
      expect(t.from).toBe('STOPPED');
      expect(t.to).toBe('NORMAL');
      expect(t.timestamp).toBe(2000);
    });

    it('fails for invalid transition (goes to STOPPED)', () => {
      const state = stateInMode('NORMAL');
      const t = attemptTransition(state, 'RECOVERY', 'invalid');
      expect(t.success).toBe(false);
      expect(t.to).toBe('STOPPED');
      expect(t.reason).toContain('fail-closed');
    });

    it('idempotent same-mode transition', () => {
      const state = stateInMode('STOPPED');
      const t = attemptTransition(state, 'STOPPED', 'already stopped');
      expect(t.success).toBe(true);
      expect(t.from).toBe('STOPPED');
      expect(t.to).toBe('STOPPED');
      expect(t.reason).toContain('idempotent');
    });

    it('handles empty reason', () => {
      const state = stateInMode('STOPPED');
      const t = attemptTransition(state, 'NORMAL', '');
      expect(t.reason).toBe('unspecified');
    });

    it('result is frozen', () => {
      const state = stateInMode('STOPPED');
      const t = attemptTransition(state, 'NORMAL', 'test');
      expect(Object.isFrozen(t)).toBe(true);
    });
  });

  describe('applyModeTransition', () => {
    it('applies successful transition', () => {
      const state = stateInMode('STOPPED', 1000);
      const t = attemptTransition(state, 'NORMAL', 'start', 2000);
      const newState = applyModeTransition(state, t);
      expect(newState.mode).toBe('NORMAL');
      expect(newState.previousMode).toBe('STOPPED');
      expect(newState.transitionCount).toBe(1);
      expect(newState.enteredCurrentModeAt).toBe(2000);
    });

    it('applies failed transition (goes to STOPPED)', () => {
      const state = stateInMode('NORMAL', 1000);
      const t = attemptTransition(state, 'RECOVERY', 'bad', 2000);
      const newState = applyModeTransition(state, t);
      expect(newState.mode).toBe('STOPPED');
    });

    it('detects stale transition (CAS violation)', () => {
      const state = stateInMode('NORMAL', 1000);
      // Simulate a transition that was computed when mode was STOPPED
      const staleTransition = Object.freeze({
        from: 'STOPPED' as ExtendedMode,
        to: 'NORMAL' as ExtendedMode,
        reason: 'stale',
        timestamp: 2000,
        success: true,
      });
      const newState = applyModeTransition(state, staleTransition);
      expect(newState.mode).toBe('STOPPED');
      expect(newState.lastTransition?.reason).toContain('stale');
    });

    it('result is frozen', () => {
      const state = stateInMode('STOPPED');
      const t = attemptTransition(state, 'NORMAL', 'test');
      const newState = applyModeTransition(state, t);
      expect(Object.isFrozen(newState)).toBe(true);
    });
  });

  describe('full FSM lifecycle', () => {
    it('STOPPED -> RECOVERY -> NORMAL -> DEGRADED -> STOPPED', () => {
      let state = createInitialModeState(1000);
      expect(state.mode).toBe('STOPPED');

      // STOPPED -> RECOVERY
      state = transitionTo(state, 'RECOVERY', 'auto-recovery', 2000);
      expect(state.mode).toBe('RECOVERY');
      expect(state.previousMode).toBe('STOPPED');

      // RECOVERY -> NORMAL
      state = transitionTo(state, 'NORMAL', 'recovery complete', 3000);
      expect(state.mode).toBe('NORMAL');
      expect(state.previousMode).toBe('RECOVERY');

      // NORMAL -> DEGRADED
      state = transitionTo(state, 'DEGRADED', 'budget warning', 4000);
      expect(state.mode).toBe('DEGRADED');
      expect(state.previousMode).toBe('NORMAL');

      // DEGRADED -> STOPPED
      state = transitionTo(state, 'STOPPED', 'budget critical', 5000);
      expect(state.mode).toBe('STOPPED');
      expect(state.previousMode).toBe('DEGRADED');
      expect(state.transitionCount).toBe(4);
    });

    it('STOPPED -> NORMAL (direct start, skip RECOVERY)', () => {
      let state = createInitialModeState(1000);
      state = transitionTo(state, 'NORMAL', 'direct start', 2000);
      expect(state.mode).toBe('NORMAL');
    });

    it('DEGRADED -> NORMAL (issue resolved)', () => {
      let state = createInitialModeState(1000);
      state = transitionTo(state, 'NORMAL', 'start', 2000);
      state = transitionTo(state, 'DEGRADED', 'warning', 3000);
      state = transitionTo(state, 'NORMAL', 'resolved', 4000);
      expect(state.mode).toBe('NORMAL');
      expect(state.previousMode).toBe('DEGRADED');
    });
  });

  describe('checkModeTimeout', () => {
    it('no timeout in NORMAL mode', () => {
      const state = stateInMode('NORMAL', 0);
      const result = checkModeTimeout(state, DEFAULT_TRANSITION_POLICY, 999_999);
      expect(result.timedOut).toBe(false);
    });

    it('no timeout in STOPPED mode', () => {
      const state = stateInMode('STOPPED', 0);
      const result = checkModeTimeout(state, DEFAULT_TRANSITION_POLICY, 999_999);
      expect(result.timedOut).toBe(false);
    });

    it('RECOVERY times out after maxRecoveryDurationMs', () => {
      const state = stateInMode('RECOVERY', 1000);
      const result = checkModeTimeout(state, DEFAULT_TRANSITION_POLICY, 1000 + 300_001);
      expect(result.timedOut).toBe(true);
      expect(result.mode).toBe('RECOVERY');
      expect(result.maxMs).toBe(300_000);
    });

    it('RECOVERY does not timeout within limit', () => {
      const state = stateInMode('RECOVERY', 1000);
      const result = checkModeTimeout(state, DEFAULT_TRANSITION_POLICY, 1000 + 100_000);
      expect(result.timedOut).toBe(false);
    });

    it('DEGRADED times out after maxDegradedDurationMs', () => {
      const state = stateInMode('DEGRADED', 1000);
      const result = checkModeTimeout(state, DEFAULT_TRANSITION_POLICY, 1000 + 600_001);
      expect(result.timedOut).toBe(true);
      expect(result.mode).toBe('DEGRADED');
      expect(result.maxMs).toBe(600_000);
    });

    it('DEGRADED does not timeout within limit', () => {
      const state = stateInMode('DEGRADED', 1000);
      const result = checkModeTimeout(state, DEFAULT_TRANSITION_POLICY, 1000 + 300_000);
      expect(result.timedOut).toBe(false);
    });

    it('result is frozen', () => {
      const state = stateInMode('NORMAL', 0);
      const result = checkModeTimeout(state);
      expect(Object.isFrozen(result)).toBe(true);
    });
  });

  describe('isModeOperational', () => {
    it('NORMAL is operational', () => {
      expect(isModeOperational('NORMAL')).toBe(true);
    });

    it('DEGRADED is operational', () => {
      expect(isModeOperational('DEGRADED')).toBe(true);
    });

    it('RECOVERY is not operational', () => {
      expect(isModeOperational('RECOVERY')).toBe(false);
    });

    it('STOPPED is not operational', () => {
      expect(isModeOperational('STOPPED')).toBe(false);
    });
  });

  describe('isModeHealthy', () => {
    it('only NORMAL is healthy', () => {
      expect(isModeHealthy('NORMAL')).toBe(true);
      expect(isModeHealthy('DEGRADED')).toBe(false);
      expect(isModeHealthy('RECOVERY')).toBe(false);
      expect(isModeHealthy('STOPPED')).toBe(false);
    });
  });

  describe('immutability', () => {
    it('all state objects are frozen', () => {
      let state = createInitialModeState(1000);
      expect(Object.isFrozen(state)).toBe(true);

      state = transitionTo(state, 'NORMAL', 'start', 2000);
      expect(Object.isFrozen(state)).toBe(true);
      expect(Object.isFrozen(state.lastTransition)).toBe(true);
    });
  });
});
