/**
 * Executor types — Discriminated union results, execution plans, cost tracking.
 *
 * All interfaces are readonly. All results are frozen.
 */

import type { PolicyDecision } from '../policy/types';
import type { EffectType, RiskTier, TraceContext } from '../types';

// =============================================================================
// Tool Categories
// =============================================================================

export const ToolCategory = Object.freeze({
  FILE_READ: 'FILE_READ',
  FILE_WRITE: 'FILE_WRITE',
  GIT: 'GIT',
  DEPLOY: 'DEPLOY',
  AUTH: 'AUTH',
  SHELL: 'SHELL',
  NETWORK: 'NETWORK',
} as const);

export type ToolCategory = (typeof ToolCategory)[keyof typeof ToolCategory];

// =============================================================================
// Tool Request (extended with execution metadata)
// =============================================================================

export interface ToolRequest {
  readonly id: string;
  readonly category: ToolCategory;
  readonly name: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly effects: readonly EffectType[];
  readonly riskTier: RiskTier;
  readonly traceContext: TraceContext;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly requestedAt: string;
  readonly idempotencyKey: string;
}

// =============================================================================
// Error Classification
// =============================================================================

export const ErrorCode = Object.freeze({
  PROVIDER_ERROR: 'PROVIDER_ERROR',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  RATE_LIMITED: 'RATE_LIMITED',
  TIMEOUT: 'TIMEOUT',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const);

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

// =============================================================================
// Execution Cost
// =============================================================================

export interface ExecutionCost {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly estimatedCostUsd: number;
  readonly specialistId: string;
  readonly pricingTier: 'fixed' | 'per_token';
}

// =============================================================================
// Retry Policy
// =============================================================================

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly initialDelayMs: number;
  readonly backoffMultiplier: number;
  readonly maxDelayMs: number;
  readonly retryableErrorCodes: readonly ErrorCode[];
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = Object.freeze({
  maxAttempts: 3,
  initialDelayMs: 500,
  backoffMultiplier: 2,
  maxDelayMs: 60_000,
  retryableErrorCodes: Object.freeze([
    ErrorCode.PROVIDER_ERROR,
    ErrorCode.RATE_LIMITED,
    ErrorCode.TIMEOUT,
  ]) as readonly ErrorCode[],
});

// =============================================================================
// Execution Plan (binds request + decision + specialist + retry)
// =============================================================================

export interface ExecutionPlan {
  readonly request: ToolRequest;
  readonly decision: PolicyDecision;
  readonly specialistId: string;
  readonly retryPolicy: RetryPolicy;
  readonly timeoutMs: number;
  readonly idempotencyKey: string;
}

// =============================================================================
// Tool Result — Discriminated Union
// =============================================================================

export const ToolResultKind = Object.freeze({
  SUCCESS: 'success',
  FAILURE: 'failure',
  DENIED: 'denied',
  TIMEOUT: 'timeout',
} as const);

export type ToolResultKind = (typeof ToolResultKind)[keyof typeof ToolResultKind];

interface BaseResult {
  readonly requestId: string;
  readonly kind: ToolResultKind;
  readonly traceContext: TraceContext;
  readonly durationMs: number;
  readonly completedAt: string;
}

export interface SuccessResult extends BaseResult {
  readonly kind: typeof ToolResultKind.SUCCESS;
  readonly data: unknown;
  readonly executionCost: ExecutionCost;
}

export interface FailureResult extends BaseResult {
  readonly kind: typeof ToolResultKind.FAILURE;
  readonly errorCode: Exclude<ErrorCode, typeof ErrorCode.TIMEOUT>;
  readonly error: string;
  readonly retryable: boolean;
}

export interface DeniedResult extends BaseResult {
  readonly kind: typeof ToolResultKind.DENIED;
  readonly policyReason: string;
  readonly alternatives?: readonly string[];
}

export interface TimeoutResult extends BaseResult {
  readonly kind: typeof ToolResultKind.TIMEOUT;
  readonly errorCode: typeof ErrorCode.TIMEOUT;
  readonly timeoutMs: number;
  readonly error: string;
  readonly retryable: true;
}

export type ToolResult = SuccessResult | FailureResult | DeniedResult | TimeoutResult;

// =============================================================================
// Freeze Helpers
// =============================================================================

export function freezeRetryPolicy(policy: RetryPolicy): RetryPolicy {
  return Object.freeze({
    ...policy,
    retryableErrorCodes: Object.freeze([...policy.retryableErrorCodes]) as readonly ErrorCode[],
  });
}

export function freezeExecutionPlan(plan: ExecutionPlan): ExecutionPlan {
  return Object.freeze({
    ...plan,
    retryPolicy: freezeRetryPolicy(plan.retryPolicy),
  });
}

export function freezeToolResult(result: ToolResult): ToolResult {
  if (result.kind === ToolResultKind.DENIED && result.alternatives) {
    return Object.freeze({
      ...result,
      alternatives: Object.freeze([...result.alternatives]) as readonly string[],
    });
  }
  return Object.freeze(result);
}

// =============================================================================
// Executor Interface
// =============================================================================

export interface ToolExecutor {
  execute(request: ToolRequest, decision: PolicyDecision, signal?: AbortSignal): Promise<ToolResult>;
}
