import { describe, expect, it, vi } from 'vitest';

import type { CircuitBreakerState } from '../../runtime/circuit-breaker';
import type { SpecialistConfig, SpecialistRegistry } from '../../specialist/types';
import { EFFECT_TYPES, type SpanId, type TraceContext, type TraceId } from '../../types';
import { createCircuitBreakerState, type CircuitBreakerState } from '../../runtime/circuit-breaker';
import { ExecutorWorker, type ExecutorWorkerConfig } from '../executor-worker';
import type { ProviderAdapter } from '../provider-adapter';
import type { SideEffectHandler } from '../side-effects';
import {
  ErrorCode,
  ToolResultKind,
  DEFAULT_RETRY_POLICY,
  freezeToolResult,
  type ExecutionPlan,
  type ToolRequest,
  type ToolResult,
} from '../types';

// =============================================================================
// Factories
// =============================================================================

function makeTraceContext(): TraceContext {
  return Object.freeze({
    traceId: 'trace-1' as TraceId,
    spanId: 'span-1' as SpanId,
    timestamp: '2026-02-11T00:00:00.000Z',
  });
}

function makeRequest(overrides: Partial<ToolRequest> = {}): ToolRequest {
  return Object.freeze({
    id: 'req-1',
    category: 'FILE_READ' as ToolRequest['category'],
    name: 'readFile',
    params: Object.freeze({ path: '/tmp/x.txt' }),
    effects: Object.freeze([EFFECT_TYPES.READ]),
    riskTier: 1 as ToolRequest['riskTier'],
    traceContext: makeTraceContext(),
    attempt: 1,
    maxAttempts: 3,
    requestedAt: '2026-02-11T00:00:00.000Z',
    idempotencyKey: 'idem-1',
    ...overrides,
  });
}

function makeRegistry(): SpecialistRegistry {
  return Object.freeze({
    specialists: Object.freeze([
      Object.freeze({ id: 'codex', name: 'Codex', trustLevel: 'TRUSTED', maxRiskTier: 4, enabled: true } as SpecialistConfig),
      Object.freeze({ id: 'glm', name: 'GLM', trustLevel: 'TRUSTED', maxRiskTier: 4, enabled: true } as SpecialistConfig),
    ]),
  });
}

function makeSuccessResult(requestId = 'req-1'): ToolResult {
  return freezeToolResult({
    requestId,
    kind: ToolResultKind.SUCCESS,
    traceContext: makeTraceContext(),
    durationMs: 10,
    completedAt: '2026-02-11T00:00:00.000Z',
    data: Object.freeze({ executed: true }),
    executionCost: Object.freeze({
      inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, specialistId: 'codex', pricingTier: 'fixed' as const,
    }),
  });
}

function makeFailureResult(retryable = true): ToolResult {
  return freezeToolResult({
    requestId: 'req-1',
    kind: ToolResultKind.FAILURE,
    traceContext: makeTraceContext(),
    durationMs: 5,
    completedAt: '2026-02-11T00:00:00.000Z',
    errorCode: ErrorCode.PROVIDER_ERROR,
    error: 'provider error',
    retryable,
  });
}

function makeTimeoutResult(): ToolResult {
  return freezeToolResult({
    requestId: 'req-1',
    kind: ToolResultKind.TIMEOUT,
    traceContext: makeTraceContext(),
    durationMs: 30_000,
    completedAt: '2026-02-11T00:00:00.000Z',
    errorCode: ErrorCode.TIMEOUT,
    timeoutMs: 30_000,
    error: 'timed out',
    retryable: true,
  });
}

function makeAdapter(sendRequest: ProviderAdapter['sendRequest']): ProviderAdapter {
  return { sendRequest };
}

function makeConfig(overrides: Partial<ExecutorWorkerConfig> = {}): ExecutorWorkerConfig {
  return {
    adapter: makeAdapter(() => Promise.resolve(makeSuccessResult())),
    registry: makeRegistry(),
    mode: 'NORMAL',
    circuitStates: new Map(),
    weeklyCount: new Map(),
    ...overrides,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('executor/ExecutorWorker', () => {
  const allowedDecision = Object.freeze({ allowed: true, reason: 'ok', traceId: 'trace-1', timestamp: '2026-02-11T00:00:00.000Z' });
  const deniedDecision = Object.freeze({ allowed: false, reason: 'policy deny', traceId: 'trace-1', timestamp: '2026-02-11T00:00:00.000Z' });

  // -------------------------------------------------------------------------
  // Policy
  // -------------------------------------------------------------------------

  it('returns DENIED when decision.allowed is false', async () => {
    const worker = new ExecutorWorker(makeConfig());

    const result = await worker.execute(makeRequest(), deniedDecision);

    expect(result.kind).toBe(ToolResultKind.DENIED);
    expect(result.requestId).toBe('req-1');
  });

  // -------------------------------------------------------------------------
  // Routing
  // -------------------------------------------------------------------------

  it('returns FAILURE when routing fails (STOPPED mode)', async () => {
    const worker = new ExecutorWorker(makeConfig({ mode: 'STOPPED' }));

    const result = await worker.execute(makeRequest(), allowedDecision);

    expect(result.kind).toBe(ToolResultKind.FAILURE);
    expect((result as { error: string }).error).toContain('routing failed');
  });

  // -------------------------------------------------------------------------
  // Success
  // -------------------------------------------------------------------------

  it('returns SuccessResult on successful execution', async () => {
    const sendRequest = vi.fn().mockResolvedValue(makeSuccessResult());
    const worker = new ExecutorWorker(makeConfig({ adapter: makeAdapter(sendRequest) }));

    const result = await worker.execute(makeRequest(), allowedDecision);

    expect(result.kind).toBe(ToolResultKind.SUCCESS);
    expect(sendRequest).toHaveBeenCalledOnce();
  });

  it('result is frozen', async () => {
    const worker = new ExecutorWorker(makeConfig());

    const result = await worker.execute(makeRequest(), allowedDecision);

    expect(Object.isFrozen(result)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Retry
  // -------------------------------------------------------------------------

  it('retries on retryable failure', async () => {
    const sendRequest = vi.fn()
      .mockResolvedValueOnce(makeFailureResult(true))
      .mockResolvedValueOnce(makeSuccessResult());
    const worker = new ExecutorWorker(makeConfig({ adapter: makeAdapter(sendRequest) }));

    const result = await worker.execute(makeRequest(), allowedDecision);

    expect(result.kind).toBe(ToolResultKind.SUCCESS);
    expect(sendRequest).toHaveBeenCalledTimes(2);
  });

  it('does not retry on non-retryable failure', async () => {
    const sendRequest = vi.fn().mockResolvedValue(makeFailureResult(false));
    const worker = new ExecutorWorker(makeConfig({ adapter: makeAdapter(sendRequest) }));

    const result = await worker.execute(makeRequest(), allowedDecision);

    expect(result.kind).toBe(ToolResultKind.FAILURE);
    expect(sendRequest).toHaveBeenCalledOnce();
  });

  it('retries on timeout', async () => {
    const sendRequest = vi.fn()
      .mockResolvedValueOnce(makeTimeoutResult())
      .mockResolvedValueOnce(makeSuccessResult());
    const worker = new ExecutorWorker(makeConfig({ adapter: makeAdapter(sendRequest) }));

    const result = await worker.execute(makeRequest(), allowedDecision);

    expect(result.kind).toBe(ToolResultKind.SUCCESS);
    expect(sendRequest).toHaveBeenCalledTimes(2);
  });

  it('gives up after maxAttempts', async () => {
    const sendRequest = vi.fn().mockResolvedValue(makeFailureResult(true));
    const worker = new ExecutorWorker(makeConfig({ adapter: makeAdapter(sendRequest) }));

    const result = await worker.execute(makeRequest(), allowedDecision);

    expect(result.kind).toBe(ToolResultKind.FAILURE);
    // DEFAULT_RETRY_POLICY.maxAttempts = 3
    expect(sendRequest).toHaveBeenCalledTimes(3);
  });

  // -------------------------------------------------------------------------
  // Side Effects
  // -------------------------------------------------------------------------

  it('calls onSuccess side effect on success', async () => {
    const sideEffects: SideEffectHandler = {
      onSuccess: vi.fn(), onFailure: vi.fn(), onTimeout: vi.fn(), onRetry: vi.fn(),
    };
    const worker = new ExecutorWorker(makeConfig({ sideEffects }));

    await worker.execute(makeRequest(), allowedDecision);

    expect(sideEffects.onSuccess).toHaveBeenCalledOnce();
  });

  it('calls onFailure side effect on final failure', async () => {
    const sideEffects: SideEffectHandler = {
      onSuccess: vi.fn(), onFailure: vi.fn(), onTimeout: vi.fn(), onRetry: vi.fn(),
    };
    const sendRequest = vi.fn().mockResolvedValue(makeFailureResult(false));
    const worker = new ExecutorWorker(makeConfig({ adapter: makeAdapter(sendRequest), sideEffects }));

    await worker.execute(makeRequest(), allowedDecision);

    expect(sideEffects.onFailure).toHaveBeenCalledOnce();
  });

  it('calls onRetry side effect on retry', async () => {
    const sideEffects: SideEffectHandler = {
      onSuccess: vi.fn(), onFailure: vi.fn(), onTimeout: vi.fn(), onRetry: vi.fn(),
    };
    const sendRequest = vi.fn()
      .mockResolvedValueOnce(makeFailureResult(true))
      .mockResolvedValueOnce(makeSuccessResult());
    const worker = new ExecutorWorker(makeConfig({ adapter: makeAdapter(sendRequest), sideEffects }));

    await worker.execute(makeRequest(), allowedDecision);

    expect(sideEffects.onRetry).toHaveBeenCalledOnce();
  });

  it('swallows side effect errors', async () => {
    const sideEffects: SideEffectHandler = {
      onSuccess: () => { throw new Error('boom'); },
      onFailure: vi.fn(), onTimeout: vi.fn(), onRetry: vi.fn(),
    };
    const worker = new ExecutorWorker(makeConfig({ sideEffects }));

    const result = await worker.execute(makeRequest(), allowedDecision);

    // Should not throw, just swallow
    expect(result.kind).toBe(ToolResultKind.SUCCESS);
  });

  // -------------------------------------------------------------------------
  // Abort
  // -------------------------------------------------------------------------

  it('returns FAILURE when aborted before attempt', async () => {
    const controller = new AbortController();
    controller.abort();
    const worker = new ExecutorWorker(makeConfig());

    const result = await worker.execute(makeRequest(), allowedDecision, controller.signal);

    expect(result.kind).toBe(ToolResultKind.FAILURE);
    expect((result as { error: string }).error).toContain('aborted');
  });

  // -------------------------------------------------------------------------
  // Circuit Breaker Integration
  // -------------------------------------------------------------------------

  it('calls onCircuitUpdate with recordSuccess on success', async () => {
    const onCircuitUpdate = vi.fn();
    const cbState = createCircuitBreakerState();
    // FILE_READ routes to glm (category bonus), so track glm
    const circuitStates = new Map([['codex', cbState], ['glm', cbState]]);
    const worker = new ExecutorWorker(makeConfig({ onCircuitUpdate, circuitStates }));

    await worker.execute(makeRequest(), allowedDecision);

    expect(onCircuitUpdate).toHaveBeenCalledOnce();
    const [specialistId, newState] = onCircuitUpdate.mock.calls[0];
    expect(specialistId).toBe('glm'); // glm preferred for FILE_READ
    expect(newState.state).toBe('CLOSED');
    expect(newState.totalSuccesses).toBe(1);
  });

  it('calls onCircuitUpdate with recordFailure on failure', async () => {
    const onCircuitUpdate = vi.fn();
    const cbState = createCircuitBreakerState();
    const circuitStates = new Map([['codex', cbState], ['glm', cbState]]);
    const sendRequest = vi.fn().mockResolvedValue(makeFailureResult(false));
    const worker = new ExecutorWorker(makeConfig({
      adapter: makeAdapter(sendRequest),
      onCircuitUpdate,
      circuitStates,
    }));

    await worker.execute(makeRequest(), allowedDecision);

    expect(onCircuitUpdate).toHaveBeenCalledOnce();
    const [specialistId, newState] = onCircuitUpdate.mock.calls[0];
    expect(specialistId).toBe('glm');
    expect(newState.totalFailures).toBe(1);
    expect(newState.consecutiveFailures).toBe(1);
  });

  it('CB opens after threshold consecutive failures', async () => {
    const updates: Array<{ id: string; state: CircuitBreakerState }> = [];
    const cbState = createCircuitBreakerState();
    const circuitStates = new Map([['codex', cbState], ['glm', cbState]]);
    const onCircuitUpdate = vi.fn((id: string, state: CircuitBreakerState) => { updates.push({ id, state }); });
    const sendRequest = vi.fn().mockResolvedValue(makeFailureResult(false));

    // 5 executions, each non-retryable so 1 attempt each
    for (let i = 0; i < 5; i++) {
      // Update circuitStates with latest state for routing
      const latestState = updates.length > 0 ? updates[updates.length - 1].state : cbState;
      circuitStates.set('glm', latestState);
      const worker = new ExecutorWorker(makeConfig({
        adapter: makeAdapter(sendRequest),
        onCircuitUpdate,
        circuitStates,
        circuitConfig: { failureThreshold: 5, cooldownMs: 30_000 },
      }));
      await worker.execute(makeRequest({ id: `req-${i}` }), allowedDecision);
    }

    // After 5 failures, CB should be OPEN
    expect(updates).toHaveLength(5);
    expect(updates[4].state.state).toBe('OPEN');
    expect(updates[4].state.consecutiveFailures).toBe(5);
  });

  it('does not record CB failure for VALIDATION_ERROR (prevents manipulation)', async () => {
    const onCircuitUpdate = vi.fn();
    const cbState = createCircuitBreakerState();
    const circuitStates = new Map([['codex', cbState], ['glm', cbState]]);
    const validationError = freezeToolResult({
      requestId: 'req-1',
      kind: ToolResultKind.FAILURE,
      traceContext: makeTraceContext(),
      durationMs: 5,
      completedAt: '2026-02-11T00:00:00.000Z',
      errorCode: ErrorCode.VALIDATION_ERROR,
      error: 'invalid params',
      retryable: false,
    });
    const sendRequest = vi.fn().mockResolvedValue(validationError);
    const worker = new ExecutorWorker(makeConfig({
      adapter: makeAdapter(sendRequest),
      onCircuitUpdate,
      circuitStates,
    }));

    await worker.execute(makeRequest(), allowedDecision);

    // VALIDATION_ERROR should NOT trigger CB failure
    expect(onCircuitUpdate).not.toHaveBeenCalled();
  });

  it('does not record CB failure for INTERNAL_ERROR (prevents manipulation)', async () => {
    const onCircuitUpdate = vi.fn();
    const cbState = createCircuitBreakerState();
    const circuitStates = new Map([['codex', cbState], ['glm', cbState]]);
    const internalError = freezeToolResult({
      requestId: 'req-1',
      kind: ToolResultKind.FAILURE,
      traceContext: makeTraceContext(),
      durationMs: 5,
      completedAt: '2026-02-11T00:00:00.000Z',
      errorCode: ErrorCode.INTERNAL_ERROR,
      error: 'internal failure',
      retryable: false,
    });
    const sendRequest = vi.fn().mockResolvedValue(internalError);
    const worker = new ExecutorWorker(makeConfig({
      adapter: makeAdapter(sendRequest),
      onCircuitUpdate,
      circuitStates,
    }));

    await worker.execute(makeRequest(), allowedDecision);

    // INTERNAL_ERROR should NOT trigger CB failure
    expect(onCircuitUpdate).not.toHaveBeenCalled();
  });

  it('does not call onCircuitUpdate when no CB state exists for specialist', async () => {
    const onCircuitUpdate = vi.fn();
    const worker = new ExecutorWorker(makeConfig({
      onCircuitUpdate,
      circuitStates: new Map(), // empty — no tracking
    }));

    await worker.execute(makeRequest(), allowedDecision);

    expect(onCircuitUpdate).not.toHaveBeenCalled();
  });

  it('swallows onCircuitUpdate errors', async () => {
    const cbState = createCircuitBreakerState();
    const circuitStates = new Map([['codex', cbState]]);
    const onCircuitUpdate = vi.fn(() => { throw new Error('persist failed'); });
    const worker = new ExecutorWorker(makeConfig({ onCircuitUpdate, circuitStates }));

    const result = await worker.execute(makeRequest(), allowedDecision);

    // Should not throw, result still returned
    expect(result.kind).toBe(ToolResultKind.SUCCESS);
  });
});
