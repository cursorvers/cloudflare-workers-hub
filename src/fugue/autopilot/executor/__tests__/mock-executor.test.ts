import { describe, expect, it } from 'vitest';

import { EFFECT_TYPES, type SpanId, type TraceContext, type TraceId } from '../../types';
import type { PolicyDecision } from '../../policy/types';
import { MockToolExecutor } from '../mock-executor';
import {
  ToolCategory,
  ToolResultKind,
  ErrorCode,
  type ToolRequest,
  type ToolResult,
  type SuccessResult,
  type DeniedResult,
  type FailureResult,
} from '../types';

function makeTraceContext(overrides: Partial<TraceContext> = {}): TraceContext {
  const base: TraceContext = {
    traceId: 'trace-1' as TraceId,
    spanId: 'span-1' as SpanId,
    timestamp: '2026-02-11T00:00:00.000Z',
  };
  return Object.freeze({ ...base, ...overrides });
}

function makeRequest(overrides: Partial<ToolRequest> = {}): ToolRequest {
  const base: ToolRequest = {
    id: 'req-1',
    category: ToolCategory.FILE_READ,
    name: 'readFile',
    params: Object.freeze({ path: '/tmp/x.txt' }),
    effects: Object.freeze([EFFECT_TYPES.WRITE]),
    riskTier: 1,
    traceContext: makeTraceContext(),
    attempt: 1,
    maxAttempts: 3,
    requestedAt: '2026-02-11T00:00:00.000Z',
    idempotencyKey: 'idem-1',
  };
  return Object.freeze({ ...base, ...overrides });
}

function makeDecision(overrides: Partial<PolicyDecision> = {}): PolicyDecision {
  const base: PolicyDecision = {
    allowed: true,
    reason: 'allowed',
    traceId: 'trace-1',
    timestamp: '2026-02-11T00:00:00.000Z',
  };
  return Object.freeze({ ...base, ...overrides });
}

describe('executor/MockToolExecutor', () => {
  it("returns 'denied' when PolicyDecision.allowed is false", async () => {
    const executor = new MockToolExecutor();
    const request = makeRequest();
    const decision = makeDecision({ allowed: false, reason: 'policy deny' });

    const result = await executor.execute(request, decision);

    expect(result.kind).toBe(ToolResultKind.DENIED);
    expect((result as DeniedResult).policyReason).toBe('policy deny');
    expect(result.requestId).toBe(request.id);
  });

  it("returns 'success' when PolicyDecision.allowed is true (default config)", async () => {
    const executor = new MockToolExecutor();
    const request = makeRequest();
    const decision = makeDecision({ allowed: true });

    const result = await executor.execute(request, decision);

    expect(result.kind).toBe(ToolResultKind.SUCCESS);
    expect((result as SuccessResult).data).toEqual({ executed: true, tool: request.name });
    expect((result as SuccessResult).executionCost.specialistId).toBe('mock');
  });

  it("returns 'failure' when shouldFail config is true", async () => {
    const executor = new MockToolExecutor({ shouldFail: true });
    const request = makeRequest();
    const decision = makeDecision({ allowed: true });

    const result = await executor.execute(request, decision);

    expect(result.kind).toBe(ToolResultKind.FAILURE);
    expect((result as FailureResult).error).toBe('mock execution failed');
    expect((result as FailureResult).errorCode).toBe(ErrorCode.INTERNAL_ERROR);
    expect((result as FailureResult).retryable).toBe(true);
  });

  it('failure with VALIDATION_ERROR is not retryable', async () => {
    const executor = new MockToolExecutor({
      shouldFail: true,
      failErrorCode: ErrorCode.VALIDATION_ERROR,
    });
    const request = makeRequest();
    const decision = makeDecision({ allowed: true });

    const result = await executor.execute(request, decision);

    expect(result.kind).toBe(ToolResultKind.FAILURE);
    expect((result as FailureResult).retryable).toBe(false);
  });

  it('freezes all returned result objects', async () => {
    const executor = new MockToolExecutor();
    const request = makeRequest();
    const decision = makeDecision();
    const denyDecision = makeDecision({ allowed: false, reason: 'deny' });
    const failExecutor = new MockToolExecutor({ shouldFail: true });

    const success = await executor.execute(request, decision);
    const denied = await executor.execute(request, denyDecision);
    const failure = await failExecutor.execute(request, decision);

    expect(Object.isFrozen(success)).toBe(true);
    expect(Object.isFrozen((success as SuccessResult).data as Record<string, unknown>)).toBe(true);
    expect(Object.isFrozen(denied)).toBe(true);
    expect(Object.isFrozen(failure)).toBe(true);
  });

  it('tracks execution history and returns immutable snapshots', async () => {
    const executor = new MockToolExecutor();
    const request = makeRequest();
    const decision = makeDecision();

    const first = await executor.execute(request, decision);
    const second = await executor.execute(makeRequest({ id: 'req-2' }), decision);
    const history = executor.getHistory();

    expect(history).toHaveLength(2);
    expect(history[0]).toBe(first);
    expect(history[1]).toBe(second);
    expect(Object.isFrozen(history)).toBe(true);
    expect(() => {
      (history as ToolResult[]).push(first);
    }).toThrow(TypeError);
  });

  it('requestId in result matches request.id', async () => {
    const executor = new MockToolExecutor();
    const request = makeRequest({ id: 'req-match' });
    const decision = makeDecision();

    const result = await executor.execute(request, decision);

    expect(result.requestId).toBe(request.id);
  });

  it('traceContext is preserved', async () => {
    const executor = new MockToolExecutor();
    const traceContext = makeTraceContext({ traceId: 'trace-xyz' as TraceId });
    const request = makeRequest({ traceContext });
    const decision = makeDecision();

    const result = await executor.execute(request, decision);

    expect(result.traceContext).toBe(traceContext);
  });

  it('durationMs is >= 0', async () => {
    const executor = new MockToolExecutor({ defaultLatencyMs: 0 });
    const request = makeRequest({ id: 'req-duration' });
    const decision = makeDecision();

    const result = await executor.execute(request, decision);

    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('completedAt is a valid ISO string', async () => {
    const executor = new MockToolExecutor();
    const request = makeRequest();
    const decision = makeDecision();

    const result = await executor.execute(request, decision);

    expect(result.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
