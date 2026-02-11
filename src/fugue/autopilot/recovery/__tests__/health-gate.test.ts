import { describe, expect, it } from 'vitest';

import {
  checkCurrentMode,
  checkHeartbeatFreshness,
  checkCircuitBreaker,
  checkBudgetStatus,
  checkManualApproval,
  evaluateHealthGate,
  DEFAULT_HEALTH_GATE_CONFIG,
  type HealthGateInput,
} from '../health-gate';
import { createInitialState, transitionMode, applyTransition } from '../../runtime/coordinator';
import { createHeartbeatState, recordHeartbeat } from '../../runtime/heartbeat';
import { createCircuitBreakerState, recordFailure as cbFail } from '../../runtime/circuit-breaker';

function createStoppedState() {
  return createInitialState(); // starts as STOPPED
}

function createNormalState() {
  const stopped = createInitialState();
  const toNormal = transitionMode(stopped, 'NORMAL', 'test', 1000);
  return applyTransition(stopped, toNormal);
}

function createFreshHeartbeat(nowMs: number) {
  return recordHeartbeat(createHeartbeatState(nowMs - 1000), nowMs);
}

function createStaleHeartbeat(nowMs: number) {
  return recordHeartbeat(createHeartbeatState(0), nowMs - 120_000);
}

describe('fugue/autopilot/recovery/health-gate', () => {
  const NOW = 100_000;

  // =========================================================================
  // Individual Checks
  // =========================================================================

  describe('checkCurrentMode', () => {
    it('passes for STOPPED mode', () => {
      const result = checkCurrentMode(createStoppedState());
      expect(result.passed).toBe(true);
      expect(result.name).toBe('current_mode');
    });

    it('fails for NORMAL mode', () => {
      const result = checkCurrentMode(createNormalState());
      expect(result.passed).toBe(false);
    });

    it('result is frozen', () => {
      const result = checkCurrentMode(createStoppedState());
      expect(Object.isFrozen(result)).toBe(true);
    });
  });

  describe('checkHeartbeatFreshness', () => {
    it('passes for recent heartbeat', () => {
      const hb = createFreshHeartbeat(NOW);
      const result = checkHeartbeatFreshness(hb, NOW, DEFAULT_HEALTH_GATE_CONFIG);
      expect(result.passed).toBe(true);
    });

    it('fails for stale heartbeat', () => {
      const hb = createStaleHeartbeat(NOW);
      const result = checkHeartbeatFreshness(hb, NOW, DEFAULT_HEALTH_GATE_CONFIG);
      expect(result.passed).toBe(false);
    });
  });

  describe('checkCircuitBreaker', () => {
    it('passes for CLOSED circuit', () => {
      const cb = createCircuitBreakerState();
      const result = checkCircuitBreaker(cb);
      expect(result.passed).toBe(true);
    });

    it('fails for OPEN circuit', () => {
      let cb = createCircuitBreakerState();
      for (let i = 0; i < 5; i++) {
        cb = cbFail(cb, NOW + i * 100);
      }
      expect(cb.state).toBe('OPEN');
      const result = checkCircuitBreaker(cb);
      expect(result.passed).toBe(false);
    });
  });

  describe('checkBudgetStatus', () => {
    it('passes below warning threshold', () => {
      const result = checkBudgetStatus(100, 200, 0.95);
      expect(result.passed).toBe(true);
    });

    it('fails at or above warning threshold', () => {
      const result = checkBudgetStatus(191, 200, 0.95);
      expect(result.passed).toBe(false);
    });

    it('fails for zero budget limit', () => {
      const result = checkBudgetStatus(0, 0, 0.95);
      expect(result.passed).toBe(false);
    });
  });

  describe('checkManualApproval', () => {
    it('passes with approval and approver', () => {
      const result = checkManualApproval(true, 'admin@test.com');
      expect(result.passed).toBe(true);
    });

    it('fails without approval', () => {
      const result = checkManualApproval(false, 'admin@test.com');
      expect(result.passed).toBe(false);
    });

    it('fails without approver', () => {
      const result = checkManualApproval(true, '');
      expect(result.passed).toBe(false);
    });

    it('fails without both', () => {
      const result = checkManualApproval(false);
      expect(result.passed).toBe(false);
    });
  });

  // =========================================================================
  // Full Health Gate
  // =========================================================================

  describe('evaluateHealthGate', () => {
    it('passes when all checks pass', () => {
      const input: HealthGateInput = {
        runtimeState: createStoppedState(),
        heartbeatState: createFreshHeartbeat(NOW),
        circuitBreakerState: createCircuitBreakerState(),
        budgetSpent: 100,
        budgetLimit: 200,
        manualApproval: true,
        approvedBy: 'admin@test.com',
        nowMs: NOW,
      };

      const result = evaluateHealthGate(input);
      expect(result.passed).toBe(true);
      expect(result.failedChecks).toHaveLength(0);
      expect(result.checks).toHaveLength(5);
    });

    it('fails when system is not STOPPED', () => {
      const input: HealthGateInput = {
        runtimeState: createNormalState(),
        heartbeatState: createFreshHeartbeat(NOW),
        circuitBreakerState: createCircuitBreakerState(),
        budgetSpent: 100,
        budgetLimit: 200,
        manualApproval: true,
        approvedBy: 'admin@test.com',
        nowMs: NOW,
      };

      const result = evaluateHealthGate(input);
      expect(result.passed).toBe(false);
      expect(result.failedChecks).toContain('current_mode');
    });

    it('fails with multiple violations', () => {
      let cb = createCircuitBreakerState();
      for (let i = 0; i < 5; i++) {
        cb = cbFail(cb, NOW + i * 100);
      }

      const input: HealthGateInput = {
        runtimeState: createStoppedState(),
        heartbeatState: createStaleHeartbeat(NOW),
        circuitBreakerState: cb,
        budgetSpent: 195,
        budgetLimit: 200,
        manualApproval: false,
        nowMs: NOW,
      };

      const result = evaluateHealthGate(input);
      expect(result.passed).toBe(false);
      expect(result.failedChecks.length).toBeGreaterThanOrEqual(3);
    });

    it('result is deeply frozen', () => {
      const input: HealthGateInput = {
        runtimeState: createStoppedState(),
        heartbeatState: createFreshHeartbeat(NOW),
        circuitBreakerState: createCircuitBreakerState(),
        budgetSpent: 100,
        budgetLimit: 200,
        manualApproval: true,
        approvedBy: 'admin@test.com',
        nowMs: NOW,
      };

      const result = evaluateHealthGate(input);
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.checks)).toBe(true);
      expect(Object.isFrozen(result.failedChecks)).toBe(true);
    });
  });
});
