import { describe, expect, it, vi } from 'vitest';

import { EFFECT_TYPES, type SpanId, type TraceContext, type TraceId } from '../../types';
import {
  CompositeSideEffectHandler,
  LoggingSideEffectHandler,
  NOOP_SIDE_EFFECT_HANDLER,
  type SideEffectHandler,
} from '../side-effects';
import {
  type ExecutionPlan,
  type ToolResult,
  ToolResultKind,
  ErrorCode,
  DEFAULT_RETRY_POLICY,
} from '../types';

/** Flush microtask queue (runDetached uses Promise.resolve().then()) */
const flush = () => new Promise((r) => setTimeout(r, 0));

function makeTraceContext(): TraceContext {
  return Object.freeze({
    traceId: 'trace-1' as TraceId,
    spanId: 'span-1' as SpanId,
    timestamp: '2026-02-11T00:00:00.000Z',
  });
}

function makeSuccessResult(): ToolResult {
  return Object.freeze({
    requestId: 'req-1',
    kind: ToolResultKind.SUCCESS,
    traceContext: makeTraceContext(),
    durationMs: 10,
    completedAt: '2026-02-11T00:00:00.000Z',
    data: Object.freeze({}),
    executionCost: Object.freeze({
      inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, specialistId: 'mock', pricingTier: 'fixed' as const,
    }),
  });
}

function makeFailureResult(): ToolResult {
  return Object.freeze({
    requestId: 'req-1',
    kind: ToolResultKind.FAILURE,
    traceContext: makeTraceContext(),
    durationMs: 5,
    completedAt: '2026-02-11T00:00:00.000Z',
    errorCode: ErrorCode.PROVIDER_ERROR,
    error: 'test error',
    retryable: true,
  });
}

function makePlan(): ExecutionPlan {
  return Object.freeze({
    request: Object.freeze({
      id: 'req-1', category: 'FILE_READ', name: 'readFile',
      params: Object.freeze({}), effects: Object.freeze([EFFECT_TYPES.READ]),
      riskTier: 1, traceContext: makeTraceContext(), attempt: 1, maxAttempts: 3,
      requestedAt: '2026-02-11T00:00:00.000Z', idempotencyKey: 'idem-1',
    }),
    decision: Object.freeze({ allowed: true, reason: 'ok', traceId: 'trace-1', timestamp: '2026-02-11T00:00:00.000Z' }),
    specialistId: 'codex',
    retryPolicy: DEFAULT_RETRY_POLICY,
    timeoutMs: 5_000,
    idempotencyKey: 'idem-1',
  }) as ExecutionPlan;
}

describe('executor/side-effects', () => {
  it('NOOP_SIDE_EFFECT_HANDLER does not throw', () => {
    expect(() => NOOP_SIDE_EFFECT_HANDLER.onSuccess(makeSuccessResult(), makePlan())).not.toThrow();
    expect(() => NOOP_SIDE_EFFECT_HANDLER.onFailure(makeFailureResult(), makePlan())).not.toThrow();
    expect(() => NOOP_SIDE_EFFECT_HANDLER.onTimeout(makeFailureResult(), makePlan())).not.toThrow();
    expect(() => NOOP_SIDE_EFFECT_HANDLER.onRetry(makeFailureResult(), makePlan(), 1)).not.toThrow();
  });

  it('NOOP_SIDE_EFFECT_HANDLER is frozen', () => {
    expect(Object.isFrozen(NOOP_SIDE_EFFECT_HANDLER)).toBe(true);
  });

  it('LoggingSideEffectHandler logs success', async () => {
    const info = vi.fn();
    const handler = new LoggingSideEffectHandler({ info, warn: vi.fn(), error: vi.fn() });

    handler.onSuccess(makeSuccessResult(), makePlan());
    await flush();

    expect(info).toHaveBeenCalledOnce();
    expect(info.mock.calls[0][0]).toContain('success');
  });

  it('LoggingSideEffectHandler logs failure', async () => {
    const error = vi.fn();
    const handler = new LoggingSideEffectHandler({ info: vi.fn(), warn: vi.fn(), error });

    handler.onFailure(makeFailureResult(), makePlan());
    await flush();

    expect(error).toHaveBeenCalledOnce();
    expect(error.mock.calls[0][0]).toContain('failure');
  });

  it('LoggingSideEffectHandler logs timeout', async () => {
    const warn = vi.fn();
    const handler = new LoggingSideEffectHandler({ info: vi.fn(), warn, error: vi.fn() });

    handler.onTimeout(makeFailureResult(), makePlan());
    await flush();

    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain('timeout');
  });

  it('LoggingSideEffectHandler logs retry', async () => {
    const warn = vi.fn();
    const handler = new LoggingSideEffectHandler({ info: vi.fn(), warn, error: vi.fn() });

    handler.onRetry(makeFailureResult(), makePlan(), 2);
    await flush();

    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain('retry');
  });

  it('CompositeSideEffectHandler calls all handlers', async () => {
    const h1: SideEffectHandler = { onSuccess: vi.fn(), onFailure: vi.fn(), onTimeout: vi.fn(), onRetry: vi.fn() };
    const h2: SideEffectHandler = { onSuccess: vi.fn(), onFailure: vi.fn(), onTimeout: vi.fn(), onRetry: vi.fn() };
    const composite = new CompositeSideEffectHandler([h1, h2]);

    composite.onSuccess(makeSuccessResult(), makePlan());
    composite.onFailure(makeFailureResult(), makePlan());
    await flush();

    expect(h1.onSuccess).toHaveBeenCalledOnce();
    expect(h2.onSuccess).toHaveBeenCalledOnce();
    expect(h1.onFailure).toHaveBeenCalledOnce();
    expect(h2.onFailure).toHaveBeenCalledOnce();
  });

  it('CompositeSideEffectHandler swallows errors from handlers', async () => {
    const throwing: SideEffectHandler = {
      onSuccess: () => { throw new Error('boom'); },
      onFailure: vi.fn(),
      onTimeout: vi.fn(),
      onRetry: vi.fn(),
    };
    const safe: SideEffectHandler = { onSuccess: vi.fn(), onFailure: vi.fn(), onTimeout: vi.fn(), onRetry: vi.fn() };
    const composite = new CompositeSideEffectHandler([throwing, safe]);

    expect(() => composite.onSuccess(makeSuccessResult(), makePlan())).not.toThrow();
    await flush();

    expect(safe.onSuccess).toHaveBeenCalledOnce();
  });
});
