/**
 * GameDay Types — Data structures for chaos engineering scenarios.
 *
 * GameDay = controlled fault injection against pure runtime functions.
 * All types are readonly. All results are frozen.
 */

import type { ExtendedMode } from '../runtime/coordinator';

// =============================================================================
// Scenario Definition
// =============================================================================

export type GameDayCategory = 'BUDGET' | 'CIRCUIT_BREAKER' | 'HEARTBEAT' | 'MODE_TRANSITION' | 'MULTI_FAULT';

export type InjectType =
  | 'BUDGET_SPEND'
  | 'BUDGET_SPIKE'
  | 'ERROR_BURST'
  | 'HEARTBEAT_STOP'
  | 'HEARTBEAT_LATE'
  | 'CB_FAILURE_BURST'
  | 'MODE_FORCE';

export interface GameDayInject {
  readonly type: InjectType;
  readonly value: number;
  readonly metadata?: Record<string, unknown>;
}

export interface GameDayStep {
  readonly t: number; // relative time offset in ms
  readonly inject: GameDayInject;
  readonly description?: string;
}

export type InvariantId =
  | 'FAIL_CLOSED'
  | 'STATE_FROZEN'
  | 'SAFE_TRANSITION'
  | 'NO_BUDGET_OVERSPEND'
  | 'AUDIT_INTEGRITY';

export interface GameDayExpectation {
  readonly finalMode: ExtendedMode;
  readonly invariants: readonly InvariantId[];
  readonly shouldStop?: boolean;
  readonly shouldDegrade?: boolean;
  readonly minThrottleLevel?: string;
}

export interface GameDayScenario {
  readonly id: string;
  readonly name: string;
  readonly category: GameDayCategory;
  readonly severity: 'CRITICAL' | 'MAJOR' | 'MINOR';
  readonly description: string;
  readonly precondition: {
    readonly mode: ExtendedMode;
    readonly budgetSpent?: number;
    readonly budgetLimit?: number;
  };
  readonly steps: readonly GameDayStep[];
  readonly expected: GameDayExpectation;
}

// =============================================================================
// Execution Results
// =============================================================================

export type StepOutcome = 'PASS' | 'FAIL' | 'ERROR';

export interface StepResult {
  readonly stepIndex: number;
  readonly t: number;
  readonly inject: GameDayInject;
  readonly outcome: StepOutcome;
  readonly stateAfter: {
    readonly mode: ExtendedMode;
    readonly budgetSpent?: number;
    readonly budgetRatio?: number;
    readonly circuitBreakerState?: string;
    readonly heartbeatStatus?: string;
    readonly throttleLevel?: string;
    readonly guardVerdict?: string;
  };
  readonly detail?: string;
}

export interface InvariantResult {
  readonly invariantId: InvariantId;
  readonly passed: boolean;
  readonly reason: string;
}

export type ScenarioStatus = 'PASS' | 'FAIL' | 'ERROR';

export interface ScenarioResult {
  readonly scenarioId: string;
  readonly scenarioName: string;
  readonly category: GameDayCategory;
  readonly severity: 'CRITICAL' | 'MAJOR' | 'MINOR';
  readonly status: ScenarioStatus;
  readonly durationMs: number;
  readonly steps: readonly StepResult[];
  readonly invariants: readonly InvariantResult[];
  readonly expected: GameDayExpectation;
  readonly actual: {
    readonly finalMode: ExtendedMode;
    readonly guardVerdict?: string;
    readonly throttleLevel?: string;
  };
  readonly failureReason?: string;
}

// =============================================================================
// Report
// =============================================================================

export interface GameDayReportMeta {
  readonly reportId: string;
  readonly quarter: string;
  readonly generatedAt: number;
  readonly environment: 'test' | 'staging';
  readonly frameworkVersion: string;
  readonly gitSha?: string;
}

export interface GameDayReportSummary {
  readonly totalScenarios: number;
  readonly passed: number;
  readonly failed: number;
  readonly errors: number;
  readonly criticalFailures: number;
  readonly overallStatus: 'PASS' | 'FAIL' | 'PASS_WITH_WARNINGS';
  readonly resiliencyScore: number; // 0-100
}

export interface GameDayReport {
  readonly meta: GameDayReportMeta;
  readonly summary: GameDayReportSummary;
  readonly results: readonly ScenarioResult[];
  readonly safetyAssertions: {
    readonly failClosedCompliant: boolean;
    readonly stateFrozenCompliant: boolean;
    readonly allInvariantsPassed: boolean;
  };
}
