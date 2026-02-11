/**
 * Executor Worker — Orchestrates tool execution with routing, retry, and side effects.
 *
 * Flow: ToolRequest + PolicyDecision → route → plan → send → retry if needed → result
 *
 * Retry uses exponential backoff per RetryPolicy.
 * All results are frozen. Side effects are fire-and-forget.
 */

import type { CircuitBreakerState } from '../runtime/circuit-breaker';
import type { ExtendedMode } from '../runtime/coordinator';
import type { PolicyDecision } from '../policy/types';
import type { SpecialistRegistry } from '../specialist/types';

import type { ProviderAdapter } from './provider-adapter';
import { routeSpecialist } from './router';
import { type SideEffectHandler, NOOP_SIDE_EFFECT_HANDLER } from './side-effects';
import {
  type ToolExecutor,
  type ToolRequest,
  type ToolResult,
  type ExecutionPlan,
  ToolResultKind,
  ErrorCode,
  DEFAULT_RETRY_POLICY,
  freezeExecutionPlan,
  freezeToolResult,
} from './types';

// =============================================================================
// Config
// =============================================================================

export interface ExecutorWorkerConfig {
  readonly adapter: ProviderAdapter;
  readonly registry: SpecialistRegistry;
  readonly mode: ExtendedMode;
  readonly circuitStates: ReadonlyMap<string, CircuitBreakerState>;
  readonly weeklyCount: ReadonlyMap<string, number>;
  readonly sideEffects?: SideEffectHandler;
}

// =============================================================================
// Helpers
// =============================================================================

function computeDelay(attempt: number, initialDelayMs: number, backoffMultiplier: number, maxDelayMs: number): number {
  const raw = initialDelayMs * Math.pow(backoffMultiplier, attempt - 1);
  return Math.min(raw, maxDelayMs);
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function isRetryable(result: ToolResult, retryableErrorCodes: readonly string[]): boolean {
  if (result.kind === ToolResultKind.TIMEOUT) return true;
  if (result.kind === ToolResultKind.FAILURE && result.retryable) {
    return retryableErrorCodes.includes(result.errorCode);
  }
  return false;
}

function nowIso(): string {
  return new Date().toISOString();
}

// =============================================================================
// Executor Worker
// =============================================================================

export class ExecutorWorker implements ToolExecutor {
  private readonly adapter: ProviderAdapter;
  private readonly registry: SpecialistRegistry;
  private readonly mode: ExtendedMode;
  private readonly circuitStates: ReadonlyMap<string, CircuitBreakerState>;
  private readonly weeklyCount: ReadonlyMap<string, number>;
  private readonly sideEffects: SideEffectHandler;

  constructor(config: ExecutorWorkerConfig) {
    this.adapter = config.adapter;
    this.registry = config.registry;
    this.mode = config.mode;
    this.circuitStates = config.circuitStates;
    this.weeklyCount = config.weeklyCount;
    this.sideEffects = config.sideEffects ?? NOOP_SIDE_EFFECT_HANDLER;
  }

  async execute(request: ToolRequest, decision: PolicyDecision, signal?: AbortSignal): Promise<ToolResult> {
    const start = performance.now();

    // 1. Policy denial — short circuit
    if (!decision.allowed) {
      return freezeToolResult({
        requestId: request.id,
        kind: ToolResultKind.DENIED,
        traceContext: request.traceContext,
        durationMs: 0,
        completedAt: nowIso(),
        policyReason: decision.reason,
      });
    }

    // 2. Route to specialist
    const routing = routeSpecialist(request, this.mode, this.circuitStates, this.weeklyCount, this.registry);
    if (routing.status !== 'routed') {
      return freezeToolResult({
        requestId: request.id,
        kind: ToolResultKind.FAILURE,
        traceContext: request.traceContext,
        durationMs: Math.round(performance.now() - start),
        completedAt: nowIso(),
        errorCode: ErrorCode.INTERNAL_ERROR,
        error: `routing failed: ${routing.reason}`,
        retryable: false,
      });
    }

    // 3. Build execution plan
    const retryPolicy = DEFAULT_RETRY_POLICY;
    const plan: ExecutionPlan = freezeExecutionPlan({
      request,
      decision,
      specialistId: routing.specialistId,
      retryPolicy,
      timeoutMs: 30_000,
      idempotencyKey: request.idempotencyKey,
    });

    // 4. Execute with retry
    return this.executeWithRetry(plan, signal);
  }

  private async executeWithRetry(plan: ExecutionPlan, signal?: AbortSignal): Promise<ToolResult> {
    const { retryPolicy } = plan;
    let lastResult: ToolResult | null = null;

    for (let attempt = 1; attempt <= retryPolicy.maxAttempts; attempt++) {
      if (signal?.aborted) {
        return freezeToolResult({
          requestId: plan.request.id,
          kind: ToolResultKind.FAILURE,
          traceContext: plan.request.traceContext,
          durationMs: 0,
          completedAt: nowIso(),
          errorCode: ErrorCode.INTERNAL_ERROR,
          error: 'request aborted before attempt',
          retryable: false,
        });
      }

      const result = await this.adapter.sendRequest(plan, signal);

      // Success or denied — no retry
      if (result.kind === ToolResultKind.SUCCESS || result.kind === ToolResultKind.DENIED) {
        try { this.sideEffects.onSuccess(result, plan); } catch { /* fire-and-forget */ }
        return result;
      }

      // Check if retryable
      if (!isRetryable(result, retryPolicy.retryableErrorCodes) || attempt >= retryPolicy.maxAttempts) {
        if (result.kind === ToolResultKind.TIMEOUT) {
          try { this.sideEffects.onTimeout(result, plan); } catch { /* fire-and-forget */ }
        } else {
          try { this.sideEffects.onFailure(result, plan); } catch { /* fire-and-forget */ }
        }
        return result;
      }

      // Retry with backoff
      lastResult = result;
      try { this.sideEffects.onRetry(result, plan, attempt); } catch { /* fire-and-forget */ }
      const backoff = computeDelay(attempt, retryPolicy.initialDelayMs, retryPolicy.backoffMultiplier, retryPolicy.maxDelayMs);
      await delay(backoff);
    }

    // Should not reach here, but fail-closed
    return lastResult ?? freezeToolResult({
      requestId: plan.request.id,
      kind: ToolResultKind.FAILURE,
      traceContext: plan.request.traceContext,
      durationMs: 0,
      completedAt: nowIso(),
      errorCode: ErrorCode.INTERNAL_ERROR,
      error: 'retry loop exhausted unexpectedly',
      retryable: false,
    });
  }
}
