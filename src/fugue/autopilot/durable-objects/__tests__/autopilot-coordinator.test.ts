import { describe, expect, it } from 'vitest';

import {
  createInitialState,
  transitionMode,
  applyTransition,
  isOperational,
  createInitialExtendedState,
  applyExtendedTransition,
  isExtendedStateOperational,
  toLegacyMode,
  type ExtendedRuntimeState,
} from '../../runtime/coordinator';
import {
  checkModeTimeout,
  DEFAULT_TRANSITION_POLICY,
  isModeOperational,
} from '../../runtime/mode-machine';
import {
  runGuardCheck,
  evaluateRecovery,
} from '../../runtime/runtime-guard';
import {
  createHeartbeatState,
  recordHeartbeat,
} from '../../runtime/heartbeat';
import {
  createCircuitBreakerState,
  recordFailure as cbRecordFailure,
  recordSuccess as cbRecordSuccess,
} from '../../runtime/circuit-breaker';

/**
 * Unit tests for AutopilotCoordinator logic.
 * Tests the pure function integration that the DO wraps.
 * DO-specific tests (storage, alarm, HTTP) require Miniflare (Phase 2 Step 9).
 */
describe('durable-objects/autopilot-coordinator (logic)', () => {
  it('initial state is STOPPED (fail-closed)', () => {
    const state = createInitialState();
    expect(state.mode).toBe('STOPPED');
    expect(isOperational(state)).toBe(false);
    expect(state.transitionCount).toBe(0);
  });

  it('STOPPED->NORMAL transition with guard check CONTINUE', () => {
    const stopped = createInitialState();
    const toNormal = transitionMode(stopped, 'NORMAL', 'manual start', 1000);
    const normal = applyTransition(stopped, toNormal);

    expect(normal.mode).toBe('NORMAL');
    expect(isOperational(normal)).toBe(true);

    // Guard check with healthy state should CONTINUE
    const heartbeat = recordHeartbeat(createHeartbeatState(0), 1000);
    const circuit = createCircuitBreakerState();
    const guardResult = runGuardCheck({
      budget: { spent: 50, limit: 200 },
      circuitBreaker: { state: circuit },
      heartbeat: { state: heartbeat },
    }, 1000);

    expect(guardResult.verdict).toBe('CONTINUE');
    expect(guardResult.shouldTransitionToStopped).toBe(false);
  });

  it('auto-STOP on budget CRITICAL', () => {
    const stopped = createInitialState();
    const toNormal = transitionMode(stopped, 'NORMAL', 'resume', 1000);
    const normal = applyTransition(stopped, toNormal);

    const guardResult = runGuardCheck({
      budget: { spent: 198, limit: 200 },
    }, 2000);

    expect(guardResult.verdict).toBe('STOP');
    expect(guardResult.shouldTransitionToStopped).toBe(true);

    // Simulate auto-stop
    const stopResult = transitionMode(normal, 'STOPPED', 'auto-stop: budget critical', 2000);
    const stoppedAgain = applyTransition(normal, stopResult);
    expect(stoppedAgain.mode).toBe('STOPPED');
    expect(isOperational(stoppedAgain)).toBe(false);
  });

  it('auto-STOP on circuit breaker OPEN', () => {
    let circuit = createCircuitBreakerState();
    const now = 1000;
    // Trigger 5 consecutive failures to open circuit
    for (let i = 0; i < 5; i++) {
      circuit = cbRecordFailure(circuit, now + i * 100);
    }
    expect(circuit.state).toBe('OPEN');

    const guardResult = runGuardCheck({
      circuitBreaker: { state: circuit },
    }, now + 600);

    expect(guardResult.verdict).toBe('STOP');
    expect(guardResult.reasons.some(r => r.includes('circuit-breaker'))).toBe(true);
  });

  it('recovery requires manual approval (fail-closed)', () => {
    const denied = evaluateRecovery({
      manualApproval: false,
      approvedBy: 'admin',
      reason: 'test recovery',
    });
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toContain('fail-closed');

    const approved = evaluateRecovery({
      manualApproval: true,
      approvedBy: 'admin@example.com',
      reason: 'verified all checks pass',
    });
    expect(approved.allowed).toBe(true);
  });

  it('recovery transitions STOPPED->NORMAL', () => {
    const stopped = createInitialState();

    const recoveryResult = evaluateRecovery({
      manualApproval: true,
      approvedBy: 'admin@example.com',
      reason: 'all health gates passed',
    });
    expect(recoveryResult.allowed).toBe(true);

    const toNormal = transitionMode(stopped, 'NORMAL', 'recovery: ' + recoveryResult.reason, 5000);
    const recovered = applyTransition(stopped, toNormal);
    expect(recovered.mode).toBe('NORMAL');
    expect(isOperational(recovered)).toBe(true);
  });

  it('heartbeat recording updates state', () => {
    const initial = createHeartbeatState(1000);
    const after = recordHeartbeat(initial, 5000);
    expect(after.lastHeartbeatMs).toBe(5000);
    expect(after.totalHeartbeats).toBe(1);
    expect(Object.isFrozen(after)).toBe(true);
  });

  it('circuit breaker success resets on recovery', () => {
    let circuit = createCircuitBreakerState();
    for (let i = 0; i < 5; i++) {
      circuit = cbRecordFailure(circuit, 1000 + i * 100);
    }
    expect(circuit.state).toBe('OPEN');

    // Recovery resets circuit breaker
    const fresh = createCircuitBreakerState();
    expect(fresh.state).toBe('CLOSED');
    expect(fresh.consecutiveFailures).toBe(0);
  });

  it('budget warning triggers DEGRADE (not STOP)', () => {
    const guardResult = runGuardCheck({
      budget: { spent: 191, limit: 200 },
    }, 3000);

    // 191/200 = 0.955 >= 0.95 warning but < 0.98 critical
    expect(guardResult.verdict).toBe('DEGRADE');
    expect(guardResult.shouldTransitionToDegraded).toBe(true);
    expect(guardResult.warnings.length).toBeGreaterThan(0);
    expect(guardResult.shouldTransitionToStopped).toBe(false);
  });

  it('multiple guard violations report all reasons', () => {
    let circuit = createCircuitBreakerState();
    for (let i = 0; i < 5; i++) {
      circuit = cbRecordFailure(circuit, 1000 + i * 100);
    }

    const guardResult = runGuardCheck({
      budget: { spent: 198, limit: 200 },
      circuitBreaker: { state: circuit },
    }, 2000);

    expect(guardResult.verdict).toBe('STOP');
    expect(guardResult.reasons.length).toBeGreaterThanOrEqual(2);
    expect(guardResult.reasons.some(r => r.includes('budget'))).toBe(true);
    expect(guardResult.reasons.some(r => r.includes('circuit-breaker'))).toBe(true);
  });

  it('all guard results are Object.freeze', () => {
    const guardResult = runGuardCheck({
      budget: { spent: 50, limit: 200 },
    }, 1000);
    expect(Object.isFrozen(guardResult)).toBe(true);
    expect(Object.isFrozen(guardResult.reasons)).toBe(true);
    expect(Object.isFrozen(guardResult.warnings)).toBe(true);
  });
});

// =============================================================================
// Phase 3: Extended Mode Integration Tests
// =============================================================================

describe('Phase 3: extended mode transitions', () => {
  it('initial extended state is STOPPED', () => {
    const state = createInitialExtendedState(1000);
    expect(state.mode).toBe('STOPPED');
    expect(isExtendedStateOperational(state)).toBe(false);
    expect(Object.isFrozen(state)).toBe(true);
  });

  it('STOPPED → RECOVERY → NORMAL (2-stage recovery)', () => {
    const stopped = createInitialExtendedState(1000);
    expect(stopped.mode).toBe('STOPPED');

    // Stage 1: STOPPED → RECOVERY
    const recovering = applyExtendedTransition(stopped, 'RECOVERY', 'recovery initiated', 2000);
    expect(recovering.mode).toBe('RECOVERY');
    expect(isExtendedStateOperational(recovering)).toBe(false); // RECOVERY is not operational
    expect(toLegacyMode(recovering.mode)).toBe('STOPPED'); // legacy sees STOPPED

    // Stage 2: RECOVERY → NORMAL
    const normal = applyExtendedTransition(recovering, 'NORMAL', 'health gate passed', 3000);
    expect(normal.mode).toBe('NORMAL');
    expect(isExtendedStateOperational(normal)).toBe(true);
    expect(toLegacyMode(normal.mode)).toBe('NORMAL');
  });

  it('NORMAL → DEGRADED on warnings', () => {
    const stopped = createInitialExtendedState(1000);
    const normal = applyExtendedTransition(stopped, 'NORMAL', 'start', 2000);
    expect(normal.mode).toBe('NORMAL');

    // DEGRADE verdict
    const degraded = applyExtendedTransition(normal, 'DEGRADED', 'auto-degrade: budget warning', 3000);
    expect(degraded.mode).toBe('DEGRADED');
    expect(isExtendedStateOperational(degraded)).toBe(true); // DEGRADED is still operational
    expect(toLegacyMode(degraded.mode)).toBe('NORMAL'); // legacy sees NORMAL
  });

  it('DEGRADED → NORMAL on recovery', () => {
    const stopped = createInitialExtendedState(1000);
    const normal = applyExtendedTransition(stopped, 'NORMAL', 'start', 2000);
    const degraded = applyExtendedTransition(normal, 'DEGRADED', 'warning', 3000);
    expect(degraded.mode).toBe('DEGRADED');

    const recovered = applyExtendedTransition(degraded, 'NORMAL', 'auto-recover', 4000);
    expect(recovered.mode).toBe('NORMAL');
  });

  it('DEGRADED → STOPPED on hard-fail', () => {
    const stopped = createInitialExtendedState(1000);
    const normal = applyExtendedTransition(stopped, 'NORMAL', 'start', 2000);
    const degraded = applyExtendedTransition(normal, 'DEGRADED', 'warning', 3000);

    const stoppedAgain = applyExtendedTransition(degraded, 'STOPPED', 'auto-stop: critical', 4000);
    expect(stoppedAgain.mode).toBe('STOPPED');
  });

  it('RECOVERY → STOPPED on timeout', () => {
    const stopped = createInitialExtendedState(1000);
    const recovering = applyExtendedTransition(stopped, 'RECOVERY', 'start recovery', 2000);
    expect(recovering.mode).toBe('RECOVERY');

    const stoppedAgain = applyExtendedTransition(recovering, 'STOPPED', 'timeout', 3000);
    expect(stoppedAgain.mode).toBe('STOPPED');
  });

  it('DEGRADED timeout triggers STOPPED', () => {
    const stopped = createInitialExtendedState(1000);
    const normal = applyExtendedTransition(stopped, 'NORMAL', 'start', 2000);
    const degraded = applyExtendedTransition(normal, 'DEGRADED', 'warning', 3000);
    expect(degraded.mode).toBe('DEGRADED');

    // Check timeout: 10min (600_000ms) after entry
    const maxDegraded = DEFAULT_TRANSITION_POLICY.maxDegradedDurationMs;
    const afterTimeout = checkModeTimeout(
      {
        mode: degraded.mode,
        previousMode: degraded.previousMode,
        lastTransition: null,
        transitionCount: degraded.transitionCount,
        enteredCurrentModeAt: degraded.enteredCurrentModeAt,
      },
      DEFAULT_TRANSITION_POLICY,
      3000 + maxDegraded + 1,
    );
    expect(afterTimeout.timedOut).toBe(true);
    expect(afterTimeout.mode).toBe('DEGRADED');
  });

  it('RECOVERY timeout triggers STOPPED', () => {
    const stopped = createInitialExtendedState(1000);
    const recovering = applyExtendedTransition(stopped, 'RECOVERY', 'start', 2000);

    const maxRecovery = DEFAULT_TRANSITION_POLICY.maxRecoveryDurationMs;
    const afterTimeout = checkModeTimeout(
      {
        mode: recovering.mode,
        previousMode: recovering.previousMode,
        lastTransition: null,
        transitionCount: recovering.transitionCount,
        enteredCurrentModeAt: recovering.enteredCurrentModeAt,
      },
      DEFAULT_TRANSITION_POLICY,
      2000 + maxRecovery + 1,
    );
    expect(afterTimeout.timedOut).toBe(true);
    expect(afterTimeout.mode).toBe('RECOVERY');
  });

  it('no timeout within allowed duration', () => {
    const stopped = createInitialExtendedState(1000);
    const recovering = applyExtendedTransition(stopped, 'RECOVERY', 'start', 2000);

    const withinLimit = checkModeTimeout(
      {
        mode: recovering.mode,
        previousMode: recovering.previousMode,
        lastTransition: null,
        transitionCount: recovering.transitionCount,
        enteredCurrentModeAt: recovering.enteredCurrentModeAt,
      },
      DEFAULT_TRANSITION_POLICY,
      2000 + 60_000, // 1 min, well within 5 min
    );
    expect(withinLimit.timedOut).toBe(false);
  });

  it('guard DEGRADE verdict drives shouldTransitionToDegraded', () => {
    const guardResult = runGuardCheck({
      budget: { spent: 191, limit: 200 },
    }, 1000);
    expect(guardResult.verdict).toBe('DEGRADE');
    expect(guardResult.shouldTransitionToDegraded).toBe(true);
    expect(guardResult.shouldTransitionToStopped).toBe(false);
  });

  it('DEGRADED mode is operational (accepts /execute)', () => {
    expect(isModeOperational('DEGRADED')).toBe(true);
    expect(isModeOperational('NORMAL')).toBe(true);
    expect(isModeOperational('RECOVERY')).toBe(false);
    expect(isModeOperational('STOPPED')).toBe(false);
  });

  it('toLegacyMode maps correctly', () => {
    expect(toLegacyMode('NORMAL')).toBe('NORMAL');
    expect(toLegacyMode('DEGRADED')).toBe('NORMAL');
    expect(toLegacyMode('RECOVERY')).toBe('STOPPED');
    expect(toLegacyMode('STOPPED')).toBe('STOPPED');
  });

  it('extended state is always frozen', () => {
    const state = createInitialExtendedState(1000);
    expect(Object.isFrozen(state)).toBe(true);

    const next = applyExtendedTransition(state, 'NORMAL', 'test', 2000);
    expect(Object.isFrozen(next)).toBe(true);
  });

  it('invalid transition fails closed to STOPPED', () => {
    const stopped = createInitialExtendedState(1000);
    // STOPPED → DEGRADED is invalid (must go through RECOVERY or NORMAL)
    const result = applyExtendedTransition(stopped, 'DEGRADED', 'invalid transition', 2000);
    expect(result.mode).toBe('STOPPED');
  });

  it('transitionCount increments on each transition', () => {
    const s0 = createInitialExtendedState(1000);
    expect(s0.transitionCount).toBe(0);

    const s1 = applyExtendedTransition(s0, 'NORMAL', 'first', 2000);
    expect(s1.transitionCount).toBe(1);

    const s2 = applyExtendedTransition(s1, 'DEGRADED', 'second', 3000);
    expect(s2.transitionCount).toBe(2);
  });
});
