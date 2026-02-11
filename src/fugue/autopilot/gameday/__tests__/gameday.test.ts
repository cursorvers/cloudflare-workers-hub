import { describe, expect, it } from 'vitest';

import { runScenario, runAllScenarios } from '../runner';
import { evaluateInvariants } from '../invariants';
import { buildReport, FRAMEWORK_VERSION } from '../report';
import {
  ALL_SCENARIOS,
  BUDGET_SCENARIOS,
  CIRCUIT_BREAKER_SCENARIOS,
  HEARTBEAT_SCENARIOS,
  MODE_TRANSITION_SCENARIOS,
} from '../scenarios';
import { budgetGradualExhaustion, budgetNormalOperation } from '../scenarios/budget';
import { cbErrorBurst, cbNormalOperation } from '../scenarios/circuit-breaker';
import { heartbeatDead, heartbeatHealthy } from '../scenarios/heartbeat';
import { modeFullLifecycle, modeForcedRecovery } from '../scenarios/mode-transition';
import type { StepResult, InvariantId } from '../types';

// =============================================================================
// Invariant Tests
// =============================================================================

describe('gameday/invariants', () => {
  const makeStep = (overrides: Partial<StepResult> = {}): StepResult =>
    Object.freeze({
      stepIndex: 0,
      t: 1000,
      inject: Object.freeze({ type: 'BUDGET_SPEND' as const, value: 10 }),
      outcome: 'PASS' as const,
      stateAfter: Object.freeze({ mode: 'NORMAL' }),
      ...overrides,
    }) as StepResult;

  it('FAIL_CLOSED passes when no errors', () => {
    const steps = [makeStep()];
    const results = evaluateInvariants(['FAIL_CLOSED'], steps, 'NORMAL');
    expect(results[0].passed).toBe(true);
  });

  it('FAIL_CLOSED fails when error but not STOPPED', () => {
    const steps = [makeStep({ outcome: 'ERROR' })];
    const results = evaluateInvariants(['FAIL_CLOSED'], steps, 'NORMAL');
    expect(results[0].passed).toBe(false);
  });

  it('FAIL_CLOSED passes when error and STOPPED', () => {
    const steps = [makeStep({ outcome: 'ERROR', stateAfter: Object.freeze({ mode: 'STOPPED' }) })];
    const results = evaluateInvariants(['FAIL_CLOSED'], steps, 'STOPPED');
    expect(results[0].passed).toBe(true);
  });

  it('STATE_FROZEN passes for valid states', () => {
    const steps = [makeStep()];
    const results = evaluateInvariants(['STATE_FROZEN'], steps, 'NORMAL');
    expect(results[0].passed).toBe(true);
  });

  it('SAFE_TRANSITION passes for valid transitions', () => {
    const steps = [
      makeStep({ stepIndex: 0, stateAfter: Object.freeze({ mode: 'NORMAL' }) }),
      makeStep({ stepIndex: 1, stateAfter: Object.freeze({ mode: 'DEGRADED' }) }),
      makeStep({ stepIndex: 2, stateAfter: Object.freeze({ mode: 'STOPPED' }) }),
    ];
    const results = evaluateInvariants(['SAFE_TRANSITION'], steps, 'STOPPED');
    expect(results[0].passed).toBe(true);
  });

  it('SAFE_TRANSITION fails for invalid transitions', () => {
    const steps = [
      makeStep({ stepIndex: 0, stateAfter: Object.freeze({ mode: 'NORMAL' }) }),
      makeStep({ stepIndex: 1, stateAfter: Object.freeze({ mode: 'RECOVERY' }) }), // NORMAL→RECOVERY invalid
    ];
    const results = evaluateInvariants(['SAFE_TRANSITION'], steps, 'RECOVERY');
    expect(results[0].passed).toBe(false);
  });

  it('NO_BUDGET_OVERSPEND passes within limit', () => {
    const steps = [makeStep({ stateAfter: Object.freeze({ mode: 'NORMAL', budgetSpent: 50 }) })];
    const results = evaluateInvariants(['NO_BUDGET_OVERSPEND'], steps, 'NORMAL', 100);
    expect(results[0].passed).toBe(true);
  });

  it('NO_BUDGET_OVERSPEND fails over limit', () => {
    const steps = [makeStep({ stateAfter: Object.freeze({ mode: 'NORMAL', budgetSpent: 110 }) })];
    const results = evaluateInvariants(['NO_BUDGET_OVERSPEND'], steps, 'NORMAL', 100);
    expect(results[0].passed).toBe(false);
  });

  it('AUDIT_INTEGRITY passes for sequential steps', () => {
    const steps = [
      makeStep({ stepIndex: 0 }),
      makeStep({ stepIndex: 1 }),
    ];
    const results = evaluateInvariants(['AUDIT_INTEGRITY'], steps, 'NORMAL');
    expect(results[0].passed).toBe(true);
  });

  it('results are frozen', () => {
    const results = evaluateInvariants(['FAIL_CLOSED', 'STATE_FROZEN'], [makeStep()], 'NORMAL');
    expect(Object.isFrozen(results)).toBe(true);
  });
});

// =============================================================================
// Budget Scenarios
// =============================================================================

describe('gameday/scenarios/budget', () => {
  it('gradual exhaustion → STOPPED', () => {
    const result = runScenario(budgetGradualExhaustion);
    expect(result.status).toBe('PASS');
    expect(result.actual.finalMode).toBe('STOPPED');
    expect(result.invariants.every(i => i.passed)).toBe(true);
  });

  it('normal operation → NORMAL', () => {
    const result = runScenario(budgetNormalOperation);
    expect(result.status).toBe('PASS');
    expect(result.actual.finalMode).toBe('NORMAL');
  });
});

// =============================================================================
// Circuit Breaker Scenarios
// =============================================================================

describe('gameday/scenarios/circuit-breaker', () => {
  it('error burst opens CB → STOPPED', () => {
    const result = runScenario(cbErrorBurst);
    expect(result.status).toBe('PASS');
    expect(result.actual.finalMode).toBe('STOPPED');
    expect(result.invariants.every(i => i.passed)).toBe(true);
  });

  it('normal load keeps CB closed → NORMAL', () => {
    const result = runScenario(cbNormalOperation);
    expect(result.status).toBe('PASS');
    expect(result.actual.finalMode).toBe('NORMAL');
  });
});

// =============================================================================
// Heartbeat Scenarios
// =============================================================================

describe('gameday/scenarios/heartbeat', () => {
  it('dead heartbeat → STOPPED', () => {
    const result = runScenario(heartbeatDead);
    expect(result.status).toBe('PASS');
    expect(result.actual.finalMode).toBe('STOPPED');
    expect(result.invariants.every(i => i.passed)).toBe(true);
  });

  it('healthy heartbeat → NORMAL', () => {
    const result = runScenario(heartbeatHealthy);
    expect(result.status).toBe('PASS');
    expect(result.actual.finalMode).toBe('NORMAL');
  });
});

// =============================================================================
// Mode Transition Scenarios
// =============================================================================

describe('gameday/scenarios/mode-transition', () => {
  it('full lifecycle → STOPPED', () => {
    const result = runScenario(modeFullLifecycle);
    expect(result.status).toBe('PASS');
    expect(result.actual.finalMode).toBe('STOPPED');
  });

  it('forced recovery path → NORMAL', () => {
    const result = runScenario(modeForcedRecovery);
    expect(result.status).toBe('PASS');
    expect(result.actual.finalMode).toBe('NORMAL');
  });
});

// =============================================================================
// Runner
// =============================================================================

describe('gameday/runner', () => {
  it('runAllScenarios executes all built-in scenarios', () => {
    const results = runAllScenarios(ALL_SCENARIOS);
    expect(results.length).toBe(8);
    expect(Object.isFrozen(results)).toBe(true);
  });

  it('all built-in scenarios pass', () => {
    const results = runAllScenarios(ALL_SCENARIOS);
    const failures = results.filter(r => r.status !== 'PASS');
    expect(failures).toEqual([]);
  });

  it('scenario results have required fields', () => {
    const result = runScenario(budgetGradualExhaustion);
    expect(result.scenarioId).toBe('GD-BUDGET-001');
    expect(result.scenarioName).toBeDefined();
    expect(result.category).toBe('BUDGET');
    expect(result.severity).toBe('CRITICAL');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.steps.length).toBe(4);
    expect(result.invariants.length).toBeGreaterThan(0);
    expect(result.expected).toBeDefined();
    expect(result.actual).toBeDefined();
  });

  it('step results are sequential', () => {
    const result = runScenario(budgetGradualExhaustion);
    result.steps.forEach((step, i) => {
      expect(step.stepIndex).toBe(i);
    });
  });

  it('results are frozen', () => {
    const result = runScenario(budgetGradualExhaustion);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.steps)).toBe(true);
    expect(Object.isFrozen(result.actual)).toBe(true);
  });
});

// =============================================================================
// Report
// =============================================================================

describe('gameday/report', () => {
  it('builds quarterly report from all scenarios', () => {
    const results = runAllScenarios(ALL_SCENARIOS);
    const report = buildReport(results, {
      quarter: '2026-Q1',
      environment: 'test',
      reportId: 'GD-TEST-001',
    });

    expect(report.meta.quarter).toBe('2026-Q1');
    expect(report.meta.environment).toBe('test');
    expect(report.meta.reportId).toBe('GD-TEST-001');
    expect(report.meta.frameworkVersion).toBe(FRAMEWORK_VERSION);
  });

  it('summary reflects all-pass results', () => {
    const results = runAllScenarios(ALL_SCENARIOS);
    const report = buildReport(results, {
      quarter: '2026-Q1',
      environment: 'test',
    });

    expect(report.summary.totalScenarios).toBe(8);
    expect(report.summary.passed).toBe(8);
    expect(report.summary.failed).toBe(0);
    expect(report.summary.errors).toBe(0);
    expect(report.summary.overallStatus).toBe('PASS');
    expect(report.summary.resiliencyScore).toBe(100);
  });

  it('safety assertions are all true for passing scenarios', () => {
    const results = runAllScenarios(ALL_SCENARIOS);
    const report = buildReport(results, {
      quarter: '2026-Q1',
      environment: 'test',
    });

    expect(report.safetyAssertions.failClosedCompliant).toBe(true);
    expect(report.safetyAssertions.stateFrozenCompliant).toBe(true);
    expect(report.safetyAssertions.allInvariantsPassed).toBe(true);
  });

  it('report is frozen', () => {
    const results = runAllScenarios(ALL_SCENARIOS);
    const report = buildReport(results, {
      quarter: '2026-Q1',
      environment: 'test',
    });

    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.meta)).toBe(true);
    expect(Object.isFrozen(report.summary)).toBe(true);
    expect(Object.isFrozen(report.safetyAssertions)).toBe(true);
  });

  it('resiliency score is 0 on critical failure (kill switch)', () => {
    const passingResults = runAllScenarios(ALL_SCENARIOS);
    const failingResult = {
      ...passingResults[0],
      status: 'FAIL' as const,
      severity: 'CRITICAL' as const,
      failureReason: 'test failure',
    };
    const mixed = [failingResult, ...passingResults.slice(1)];
    const report = buildReport(mixed, {
      quarter: '2026-Q1',
      environment: 'test',
    });

    expect(report.summary.overallStatus).toBe('FAIL');
    expect(report.summary.resiliencyScore).toBe(0);
  });

  it('resiliency score is 0 on error (kill switch)', () => {
    const passingResults = runAllScenarios(ALL_SCENARIOS);
    const errorResult = {
      ...passingResults[0],
      status: 'ERROR' as const,
      severity: 'MAJOR' as const,
      failureReason: 'runtime error',
    };
    const mixed = [errorResult, ...passingResults.slice(1)];
    const report = buildReport(mixed, {
      quarter: '2026-Q1',
      environment: 'test',
    });

    expect(report.summary.overallStatus).toBe('FAIL');
    expect(report.summary.resiliencyScore).toBe(0);
    expect(report.summary.errors).toBe(1);
  });
});

// =============================================================================
// Scenario Counts
// =============================================================================

describe('gameday/scenarios', () => {
  it('all scenario collections have correct counts', () => {
    expect(BUDGET_SCENARIOS.length).toBe(2);
    expect(CIRCUIT_BREAKER_SCENARIOS.length).toBe(2);
    expect(HEARTBEAT_SCENARIOS.length).toBe(2);
    expect(MODE_TRANSITION_SCENARIOS.length).toBe(2);
    expect(ALL_SCENARIOS.length).toBe(8);
  });

  it('all scenarios have unique IDs', () => {
    const ids = ALL_SCENARIOS.map(s => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('all scenarios are frozen', () => {
    ALL_SCENARIOS.forEach(s => {
      expect(Object.isFrozen(s)).toBe(true);
    });
  });
});
