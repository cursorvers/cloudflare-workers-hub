import { describe, expect, it, vi } from 'vitest';

import type { CircuitBreakerState } from '../../runtime/circuit-breaker';
import type { SpecialistConfig, SpecialistRegistry } from '../../specialist/types';
import { EFFECT_TYPES, type SpanId, type TraceContext, type TraceId } from '../../types';
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
});
