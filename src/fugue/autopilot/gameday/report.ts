/**
 * GameDay Report — Quarterly audit report builder.
 *
 * Generates structured reports with progressive disclosure:
 *   Level 1: Executive summary (overall status, resiliency score)
 *   Level 2: Scenario breakdown (per-scenario status)
 *   Level 3: Technical details (steps, invariants, assertions)
 *
 * All functions are pure and return frozen objects.
 */

import type {
  GameDayReport,
  GameDayReportMeta,
  GameDayReportSummary,
  ScenarioResult,
} from './types';

// =============================================================================
// Constants
// =============================================================================

export const FRAMEWORK_VERSION = '1.2.0';

// =============================================================================
// Report Builder
// =============================================================================

function computeSummary(results: readonly ScenarioResult[]): GameDayReportSummary {
  const total = results.length;
  const passed = results.filter(r => r.status === 'PASS').length;
  const failed = results.filter(r => r.status === 'FAIL').length;
  const errors = results.filter(r => r.status === 'ERROR').length;
  const criticalFailures = results.filter(
    r => r.status !== 'PASS' && r.severity === 'CRITICAL',
  ).length;

  let overallStatus: GameDayReportSummary['overallStatus'];
  if (criticalFailures > 0 || errors > 0) {
    overallStatus = 'FAIL';
  } else if (failed > 0) {
    overallStatus = 'PASS_WITH_WARNINGS';
  } else {
    overallStatus = 'PASS';
  }

  // Resiliency score: 0-100
  // Critical failure or error → score forced to 0 (safety kill switch)
  // Otherwise: (passed / total) * 100
  let resiliencyScore: number;
  if (criticalFailures > 0 || errors > 0) {
    resiliencyScore = 0;
  } else {
    resiliencyScore = total > 0 ? Math.round((passed / total) * 100) : 0;
  }

  return Object.freeze({
    totalScenarios: total,
    passed,
    failed,
    errors,
    criticalFailures,
    overallStatus,
    resiliencyScore,
  });
}

function computeSafetyAssertions(results: readonly ScenarioResult[]): GameDayReport['safetyAssertions'] {
  const allInvariants = results.flatMap(r => [...r.invariants]);

  // Require at least one matching invariant — vacuous truth is not compliant
  const failClosedItems = allInvariants.filter(i => i.invariantId === 'FAIL_CLOSED');
  const failClosedCompliant = failClosedItems.length > 0 && failClosedItems.every(i => i.passed);

  const stateFrozenItems = allInvariants.filter(i => i.invariantId === 'STATE_FROZEN');
  const stateFrozenCompliant = stateFrozenItems.length > 0 && stateFrozenItems.every(i => i.passed);

  const allInvariantsPassed = allInvariants.length > 0 && allInvariants.every(i => i.passed);

  return Object.freeze({
    failClosedCompliant,
    stateFrozenCompliant,
    allInvariantsPassed,
  });
}

/**
 * Build a quarterly GameDay report from scenario results.
 */
export function buildReport(
  results: readonly ScenarioResult[],
  options: {
    readonly quarter: string;
    readonly environment: 'test' | 'staging';
    readonly gitSha?: string;
    readonly reportId?: string;
  },
): GameDayReport {
  const meta: GameDayReportMeta = Object.freeze({
    reportId: options.reportId ?? `GD-${options.quarter}-${Date.now()}`,
    quarter: options.quarter,
    generatedAt: Date.now(),
    environment: options.environment,
    frameworkVersion: FRAMEWORK_VERSION,
    gitSha: options.gitSha,
  });

  const summary = computeSummary(results);
  const safetyAssertions = computeSafetyAssertions(results);

  return Object.freeze({
    meta,
    summary,
    results: Object.freeze([...results]),
    safetyAssertions,
  });
}
