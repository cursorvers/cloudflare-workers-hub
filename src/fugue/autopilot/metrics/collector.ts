/**
 * Metrics Collector — Low-cost in-memory metrics for observability.
 *
 * Uses fixed-size ring buffers to bound memory.
 * Low cardinality only (GLM MINOR: no user IDs or request IDs in labels).
 * All state is immutable and frozen.
 */

// =============================================================================
// Constants
// =============================================================================

/** Ring buffer size for time-series data */
export const RING_BUFFER_SIZE = 60; // 60 samples ≈ 10 minutes at 10s alarm

// =============================================================================
// Types
// =============================================================================

export interface ModeTransitionMetric {
  readonly from: string;
  readonly to: string;
  readonly reason: string;
  readonly timestamp: number;
}

export interface ExecutionMetric {
  readonly category: string;
  readonly success: boolean;
  readonly durationMs: number;
  readonly async: boolean;
  readonly timestamp: number;
}

export interface GuardVerdictMetric {
  readonly verdict: string;
  readonly reasons: readonly string[];
  readonly timestamp: number;
}

export interface MetricsSnapshot {
  readonly modeTransitions: {
    readonly total: number;
    readonly recent: readonly ModeTransitionMetric[];
  };
  readonly executions: {
    readonly total: number;
    readonly succeeded: number;
    readonly failed: number;
    readonly avgDurationMs: number;
    readonly asyncCount: number;
  };
  readonly guardVerdicts: {
    readonly total: number;
    readonly stopCount: number;
    readonly degradeCount: number;
    readonly continueCount: number;
  };
  readonly uptime: {
    readonly startedAt: number;
    readonly currentMode: string;
    readonly modeEnteredAt: number;
  };
  readonly collectedAt: number;
}

export interface MetricsState {
  readonly modeTransitions: readonly ModeTransitionMetric[];
  readonly modeTransitionTotal: number;
  readonly executions: readonly ExecutionMetric[];
  readonly executionTotal: number;
  readonly executionSucceeded: number;
  readonly executionFailed: number;
  readonly executionAsyncCount: number;
  readonly guardVerdicts: readonly GuardVerdictMetric[];
  readonly guardVerdictTotal: number;
  readonly guardStopCount: number;
  readonly guardDegradeCount: number;
  readonly guardContinueCount: number;
  readonly startedAt: number;
  readonly currentMode: string;
  readonly modeEnteredAt: number;
}

// =============================================================================
// Pure Functions
// =============================================================================

export function createMetricsState(nowMs: number): MetricsState {
  return Object.freeze({
    modeTransitions: Object.freeze([]),
    modeTransitionTotal: 0,
    executions: Object.freeze([]),
    executionTotal: 0,
    executionSucceeded: 0,
    executionFailed: 0,
    executionAsyncCount: 0,
    guardVerdicts: Object.freeze([]),
    guardVerdictTotal: 0,
    guardStopCount: 0,
    guardDegradeCount: 0,
    guardContinueCount: 0,
    startedAt: nowMs,
    currentMode: 'STOPPED',
    modeEnteredAt: nowMs,
  });
}

export function recordModeTransition(
  state: MetricsState,
  metric: ModeTransitionMetric,
): MetricsState {
  const recent = [metric, ...state.modeTransitions].slice(0, RING_BUFFER_SIZE);

  return Object.freeze({
    ...state,
    modeTransitions: Object.freeze(recent),
    modeTransitionTotal: state.modeTransitionTotal + 1,
    currentMode: metric.to,
    modeEnteredAt: metric.timestamp,
  });
}

export function recordExecution(
  state: MetricsState,
  metric: ExecutionMetric,
): MetricsState {
  const recent = [metric, ...state.executions].slice(0, RING_BUFFER_SIZE);

  return Object.freeze({
    ...state,
    executions: Object.freeze(recent),
    executionTotal: state.executionTotal + 1,
    executionSucceeded: metric.success ? state.executionSucceeded + 1 : state.executionSucceeded,
    executionFailed: metric.success ? state.executionFailed : state.executionFailed + 1,
    executionAsyncCount: metric.async ? state.executionAsyncCount + 1 : state.executionAsyncCount,
  });
}

export function recordGuardVerdict(
  state: MetricsState,
  metric: GuardVerdictMetric,
): MetricsState {
  const recent = [metric, ...state.guardVerdicts].slice(0, RING_BUFFER_SIZE);

  return Object.freeze({
    ...state,
    guardVerdicts: Object.freeze(recent),
    guardVerdictTotal: state.guardVerdictTotal + 1,
    guardStopCount: metric.verdict === 'STOP' ? state.guardStopCount + 1 : state.guardStopCount,
    guardDegradeCount: metric.verdict === 'DEGRADE' ? state.guardDegradeCount + 1 : state.guardDegradeCount,
    guardContinueCount: metric.verdict === 'CONTINUE' ? state.guardContinueCount + 1 : state.guardContinueCount,
  });
}

/**
 * Produce a frozen snapshot for the /metrics endpoint.
 */
export function createSnapshot(state: MetricsState): MetricsSnapshot {
  const successfulExecs = state.executions.filter((e) => e.success);
  const avgDurationMs = successfulExecs.length > 0
    ? successfulExecs.reduce((sum, e) => sum + e.durationMs, 0) / successfulExecs.length
    : 0;

  return Object.freeze({
    modeTransitions: Object.freeze({
      total: state.modeTransitionTotal,
      recent: state.modeTransitions,
    }),
    executions: Object.freeze({
      total: state.executionTotal,
      succeeded: state.executionSucceeded,
      failed: state.executionFailed,
      avgDurationMs: Math.round(avgDurationMs),
      asyncCount: state.executionAsyncCount,
    }),
    guardVerdicts: Object.freeze({
      total: state.guardVerdictTotal,
      stopCount: state.guardStopCount,
      degradeCount: state.guardDegradeCount,
      continueCount: state.guardContinueCount,
    }),
    uptime: Object.freeze({
      startedAt: state.startedAt,
      currentMode: state.currentMode,
      modeEnteredAt: state.modeEnteredAt,
    }),
    collectedAt: Date.now(),
  });
}

/**
 * Export metrics in Prometheus text format.
 * Low cardinality: no user/request IDs.
 */
export function exportPrometheus(snapshot: MetricsSnapshot): string {
  const lines: string[] = [];

  lines.push('# HELP autopilot_mode_transitions_total Total mode transitions');
  lines.push('# TYPE autopilot_mode_transitions_total counter');
  lines.push(`autopilot_mode_transitions_total ${snapshot.modeTransitions.total}`);

  lines.push('# HELP autopilot_executions_total Total tool executions');
  lines.push('# TYPE autopilot_executions_total counter');
  lines.push(`autopilot_executions_total{result="success"} ${snapshot.executions.succeeded}`);
  lines.push(`autopilot_executions_total{result="failure"} ${snapshot.executions.failed}`);

  lines.push('# HELP autopilot_execution_duration_avg_ms Average execution duration');
  lines.push('# TYPE autopilot_execution_duration_avg_ms gauge');
  lines.push(`autopilot_execution_duration_avg_ms ${snapshot.executions.avgDurationMs}`);

  lines.push('# HELP autopilot_executions_async_total Total async executions');
  lines.push('# TYPE autopilot_executions_async_total counter');
  lines.push(`autopilot_executions_async_total ${snapshot.executions.asyncCount}`);

  lines.push('# HELP autopilot_guard_verdicts_total Total guard verdicts');
  lines.push('# TYPE autopilot_guard_verdicts_total counter');
  lines.push(`autopilot_guard_verdicts_total{verdict="STOP"} ${snapshot.guardVerdicts.stopCount}`);
  lines.push(`autopilot_guard_verdicts_total{verdict="DEGRADE"} ${snapshot.guardVerdicts.degradeCount}`);
  lines.push(`autopilot_guard_verdicts_total{verdict="CONTINUE"} ${snapshot.guardVerdicts.continueCount}`);

  lines.push('# HELP autopilot_current_mode Current operating mode');
  lines.push('# TYPE autopilot_current_mode gauge');
  lines.push(`autopilot_current_mode{mode="${snapshot.uptime.currentMode}"} 1`);

  return lines.join('\n') + '\n';
}

/**
 * Create a compact operational summary for dashboards.
 */
export function createOpsSummary(
  snapshot: MetricsSnapshot,
  providerHealth: readonly { provider: string; available: boolean; successRate: number }[],
): Record<string, unknown> {
  const execSuccessRate = snapshot.executions.total > 0
    ? snapshot.executions.succeeded / snapshot.executions.total
    : 1.0;

  return Object.freeze({
    mode: snapshot.uptime.currentMode,
    uptimeMs: snapshot.collectedAt - snapshot.uptime.startedAt,
    modeTransitions: snapshot.modeTransitions.total,
    executions: {
      total: snapshot.executions.total,
      successRate: Math.round(execSuccessRate * 100) / 100,
      avgDurationMs: snapshot.executions.avgDurationMs,
    },
    guardVerdicts: {
      total: snapshot.guardVerdicts.total,
      stopRate: snapshot.guardVerdicts.total > 0
        ? Math.round((snapshot.guardVerdicts.stopCount / snapshot.guardVerdicts.total) * 100) / 100
        : 0,
    },
    providers: providerHealth.map((p) => ({
      id: p.provider,
      available: p.available,
      successRate: Math.round(p.successRate * 100) / 100,
    })),
    collectedAt: snapshot.collectedAt,
  });
}
