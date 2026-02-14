/**
 * Health Gate for STOPPED→NORMAL Recovery
 *
 * Pre-recovery checklist that validates system health before
 * allowing mode transition from STOPPED to NORMAL.
 *
 * Checks:
 * 1. Heartbeat freshness (recent heartbeat within threshold)
 * 2. Circuit breaker state (must be CLOSED)
 * 3. Budget status (must be below warning threshold)
 * 4. Manual approval (fail-closed: always required)
 */

import type { HeartbeatState } from '../runtime/heartbeat';
import type { CircuitBreakerState } from '../runtime/circuit-breaker';
import type { RuntimeState, ExtendedRuntimeState, ExtendedMode } from '../runtime/coordinator';

// =============================================================================
// Configuration
// =============================================================================

export interface HealthGateConfig {
  readonly heartbeatMaxAgeMs: number;
  readonly budgetWarningThreshold: number;
}

export const DEFAULT_HEALTH_GATE_CONFIG: HealthGateConfig = Object.freeze({
  heartbeatMaxAgeMs: 60_000,       // 60 seconds
  budgetWarningThreshold: 0.95,    // 95% of budget
});

// =============================================================================
// Types
// =============================================================================

export interface HealthGateInput {
  readonly runtimeState: RuntimeState;
  readonly heartbeatState: HeartbeatState;
  readonly circuitBreakerState: CircuitBreakerState;
  readonly budgetSpent: number;
  readonly budgetLimit: number;
  readonly manualApproval: boolean;
  readonly approvedBy?: string;
  readonly nowMs?: number;
}

export interface HealthGateCheck {
  readonly name: string;
  readonly passed: boolean;
  readonly reason: string;
}

export interface HealthGateResult {
  readonly passed: boolean;
  readonly checks: readonly HealthGateCheck[];
  readonly failedChecks: readonly string[];
  readonly timestamp: number;
}

// =============================================================================
// Individual Check Functions (Pure)
// =============================================================================

export function checkCurrentMode(runtimeState: RuntimeState): HealthGateCheck {
  const passed = runtimeState.mode === 'STOPPED';
  return Object.freeze({
    name: 'current_mode',
    passed,
    reason: passed ? 'System is in STOPPED mode (recovery eligible)' : `System is in ${runtimeState.mode} mode (must be STOPPED)`,
  });
}

/**
 * Extended mode check: allows recovery from STOPPED or RECOVERY modes.
 */
export function checkCurrentModeExtended(mode: ExtendedMode): HealthGateCheck {
  const recoveryEligible = mode === 'STOPPED' || mode === 'RECOVERY';
  return Object.freeze({
    name: 'current_mode',
    passed: recoveryEligible,
    reason: recoveryEligible
      ? `System is in ${mode} mode (recovery eligible)`
      : `System is in ${mode} mode (must be STOPPED or RECOVERY)`,
  });
}

export function checkHeartbeatFreshness(
  heartbeatState: HeartbeatState,
  nowMs: number,
  config: HealthGateConfig,
): HealthGateCheck {
  if (heartbeatState.lastHeartbeatMs === null) {
    return Object.freeze({
      name: 'heartbeat_freshness',
      passed: false,
      reason: 'No heartbeat recorded (recovery not eligible)',
    });
  }

  const age = nowMs - heartbeatState.lastHeartbeatMs;
  const passed = age <= config.heartbeatMaxAgeMs;
  return Object.freeze({
    name: 'heartbeat_freshness',
    passed,
    reason: passed
      ? `Last heartbeat ${age}ms ago (within ${config.heartbeatMaxAgeMs}ms threshold)`
      : `Last heartbeat ${age}ms ago (exceeds ${config.heartbeatMaxAgeMs}ms threshold)`,
  });
}

export function checkCircuitBreaker(
  circuitBreakerState: CircuitBreakerState,
): HealthGateCheck {
  const passed = circuitBreakerState.state === 'CLOSED';
  return Object.freeze({
    name: 'circuit_breaker',
    passed,
    reason: passed
      ? 'Circuit breaker is CLOSED (healthy)'
      : `Circuit breaker is ${circuitBreakerState.state} (must be CLOSED)`,
  });
}

export function checkBudgetStatus(
  spent: number,
  limit: number,
  warningThreshold: number,
): HealthGateCheck {
  if (limit <= 0) {
    return Object.freeze({
      name: 'budget_status',
      passed: false,
      reason: 'Budget limit is zero or negative',
    });
  }

  const ratio = spent / limit;
  const passed = ratio < warningThreshold;
  return Object.freeze({
    name: 'budget_status',
    passed,
    reason: passed
      ? `Budget usage ${(ratio * 100).toFixed(1)}% (below ${(warningThreshold * 100).toFixed(0)}% threshold)`
      : `Budget usage ${(ratio * 100).toFixed(1)}% (at or above ${(warningThreshold * 100).toFixed(0)}% threshold)`,
  });
}

export function checkManualApproval(
  manualApproval: boolean,
  approvedBy?: string,
): HealthGateCheck {
  const passed = manualApproval && !!approvedBy && approvedBy.length > 0;
  return Object.freeze({
    name: 'manual_approval',
    passed,
    reason: passed
      ? `Manual approval granted by ${approvedBy}`
      : 'Manual approval required (fail-closed policy)',
  });
}

// =============================================================================
// Main Health Gate Evaluation (Pure)
// =============================================================================

/**
 * Evaluate all health gate checks for STOPPED→NORMAL recovery.
 * All checks must pass for recovery to be allowed.
 */
export function evaluateHealthGate(
  input: HealthGateInput,
  config: HealthGateConfig = DEFAULT_HEALTH_GATE_CONFIG,
): HealthGateResult {
  const nowMs = input.nowMs ?? Date.now();

  const checks: HealthGateCheck[] = [
    checkCurrentMode(input.runtimeState),
    checkHeartbeatFreshness(input.heartbeatState, nowMs, config),
    checkCircuitBreaker(input.circuitBreakerState),
    checkBudgetStatus(input.budgetSpent, input.budgetLimit, config.budgetWarningThreshold),
    checkManualApproval(input.manualApproval, input.approvedBy),
  ];

  const failedChecks = checks
    .filter((c) => !c.passed)
    .map((c) => c.name);

  return Object.freeze({
    passed: failedChecks.length === 0,
    checks: Object.freeze(checks),
    failedChecks: Object.freeze(failedChecks),
    timestamp: nowMs,
  });
}
