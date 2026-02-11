import { checkBudget, type BudgetCheckResult, type BudgetSeverity } from "./budget-guard";
import {
  checkErrorRate,
  type ErrorRateResult,
} from "./error-rate-monitor";
import { type CircuitBreakerState } from "./circuit-breaker";
import {
  checkHeartbeat,
  type HeartbeatCheckResult,
  type HeartbeatState,
} from "./heartbeat";
import { checkQuery, type QueryGuardResult } from "./query-guard";
import {
  predictBudgetExhaustion,
  type BudgetSample,
  type BudgetPrediction,
  type PredictionConfig,
} from "./budget-predictor";
import {
  computeThrottle,
  type ThrottleState,
  type ThrottleConfig,
} from "./throttle-policy";

export type GuardVerdict = "CONTINUE" | "DEGRADE" | "STOP" | "RECOVERY_PENDING";

export interface GuardInput {
  readonly budget?: { readonly spent: number; readonly limit: number };
  readonly errorRate?: { readonly errors: number; readonly total: number };
  readonly circuitBreaker?: { readonly state: CircuitBreakerState };
  readonly heartbeat?: { readonly state: HeartbeatState };
  readonly query?: { readonly query: string; readonly params: readonly unknown[] };
  /** Optional: budget samples for prediction-based throttling */
  readonly budgetSamples?: readonly BudgetSample[];
  readonly predictionConfig?: PredictionConfig;
  readonly throttleConfig?: ThrottleConfig;
}

export interface GuardCheckResult {
  readonly verdict: GuardVerdict;
  readonly shouldTransitionToStopped: boolean;
  readonly shouldTransitionToDegraded: boolean;
  readonly reasons: readonly string[];
  readonly warnings: readonly string[];
  readonly timestamp: number;
  readonly guardResults: {
    readonly budget?: BudgetCheckResult;
    readonly errorRate?: ErrorRateResult;
    readonly circuitBreaker?: Readonly<{ readonly state: CircuitBreakerState }>;
    readonly heartbeat?: HeartbeatCheckResult;
    readonly query?: QueryGuardResult;
  };
  /** Budget prediction result (only when budgetSamples provided) */
  readonly prediction?: BudgetPrediction;
  /** Throttle state (only when budget + budgetSamples provided) */
  readonly throttle?: ThrottleState;
}

export interface RecoveryRequest {
  readonly manualApproval: boolean;
  readonly approvedBy: string;
  readonly reason: string;
}

export interface RecoveryResult {
  readonly allowed: boolean;
  readonly reason: string;
}

function safeNow(nowMs?: number): number {
  if (typeof nowMs !== "number" || !Number.isFinite(nowMs)) {
    return Date.now();
  }
  return nowMs;
}

function freezeStrings(values: readonly string[]): readonly string[] {
  return Object.freeze([...values]);
}

function freezeGuardResults(
  results: GuardCheckResult["guardResults"],
): GuardCheckResult["guardResults"] {
  return Object.freeze({ ...results });
}

// Unified guard check across all runtime monitors.
export function runGuardCheck(
  input: GuardInput,
  nowMs?: number,
): GuardCheckResult {
  const timestamp = safeNow(nowMs);
  const reasons: string[] = [];
  const warnings: string[] = [];
  const guardResults: {
    budget?: BudgetCheckResult;
    errorRate?: ErrorRateResult;
    circuitBreaker?: Readonly<{ state: CircuitBreakerState }>;
    heartbeat?: HeartbeatCheckResult;
    query?: QueryGuardResult;
  } = {};

  if (input.budget != null) {
    const result = checkBudget(input.budget.spent, input.budget.limit);
    guardResults.budget = result;
    if (result.severity === "CRITICAL" || result.action === "stop") {
      reasons.push(`budget: ${result.reason}`);
    } else if (result.severity === "WARNING") {
      warnings.push(`budget: ${result.reason}`);
    }
  }

  if (input.errorRate != null) {
    const result = checkErrorRate(input.errorRate.errors, input.errorRate.total);
    guardResults.errorRate = result;
    if (result.severity === "CRITICAL" || result.action === "stop") {
      reasons.push(`error-rate: ${result.reason}`);
    } else if (result.severity === "INSUFFICIENT_DATA") {
      warnings.push(`error-rate: ${result.reason}`);
    }
  }

  if (input.circuitBreaker != null) {
    const circuit = Object.freeze({ state: input.circuitBreaker.state });
    guardResults.circuitBreaker = circuit;
    if (circuit.state.state === "OPEN") {
      reasons.push("circuit-breaker: state OPEN");
    } else if (circuit.state.state === "HALF_OPEN") {
      warnings.push("circuit-breaker: state HALF_OPEN");
    }
  }

  if (input.heartbeat != null) {
    const result = checkHeartbeat(input.heartbeat.state, undefined, timestamp);
    guardResults.heartbeat = result;
    if (result.status === "DEAD" || result.shouldStop) {
      reasons.push(`heartbeat: ${result.reason}`);
    } else if (result.status === "LATE") {
      warnings.push(`heartbeat: ${result.reason}`);
    }
  }

  if (input.query != null) {
    const result = checkQuery(input.query.query, input.query.params);
    guardResults.query = result;
    if (result.safety === "BLOCKED" || !result.allowed) {
      reasons.push(`query: ${result.reason}`);
    } else if (result.safety === "SUSPICIOUS") {
      warnings.push(`query: ${result.reason}`);
    }
  }

  // Budget prediction + throttle (optional, when samples provided)
  let prediction: BudgetPrediction | undefined;
  let throttle: ThrottleState | undefined;

  if (input.budget != null && input.budgetSamples != null && input.budgetSamples.length > 0) {
    // Inject current budget point to ensure prediction uses latest data
    const currentPoint: BudgetSample = { timestamp, spent: input.budget.spent };
    const samplesWithCurrent = [...input.budgetSamples, currentPoint];

    prediction = predictBudgetExhaustion(
      samplesWithCurrent,
      input.budget.limit,
      timestamp,
      input.predictionConfig,
    );

    const budgetSeverity: BudgetSeverity = guardResults.budget
      ? guardResults.budget.severity
      : "OK";

    throttle = computeThrottle(prediction, budgetSeverity, input.throttleConfig);
  }

  const shouldStop = reasons.length > 0;
  const shouldDegrade = !shouldStop && warnings.length > 0;
  const verdict: GuardVerdict = shouldStop
    ? "STOP"
    : shouldDegrade
      ? "DEGRADE"
      : "CONTINUE";

  return Object.freeze({
    verdict,
    shouldTransitionToStopped: shouldStop,
    shouldTransitionToDegraded: shouldDegrade,
    reasons: freezeStrings(reasons),
    warnings: freezeStrings(warnings),
    timestamp,
    guardResults: freezeGuardResults(guardResults),
    prediction,
    throttle,
  });
}

function normalizeText(value: string): string {
  return typeof value === "string" ? value.trim() : "";
}

// Recovery evaluation requiring manual approval. Fail-closed without approval.
export function evaluateRecovery(
  request: RecoveryRequest,
): RecoveryResult {
  const approvedBy = normalizeText(request.approvedBy);
  const reason = normalizeText(request.reason);

  if (!request.manualApproval) {
    return Object.freeze({
      allowed: false,
      reason: "fail-closed: manual approval required",
    });
  }

  if (approvedBy.length === 0) {
    return Object.freeze({
      allowed: false,
      reason: "fail-closed: approvedBy is required",
    });
  }

  if (reason.length === 0) {
    return Object.freeze({
      allowed: false,
      reason: "fail-closed: reason is required",
    });
  }

  return Object.freeze({
    allowed: true,
    reason: `recovery approved by ${approvedBy}: ${reason}`,
  });
}
