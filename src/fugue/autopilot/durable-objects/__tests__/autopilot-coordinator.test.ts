import { describe, expect, it } from 'vitest';

import {
  createInitialState,
  transitionMode,
  applyTransition,
  isOperational,
} from '../../runtime/coordinator';
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
