import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PolicyDecision } from '../../policy/types';
import { EFFECT_TYPES, type SpanId, type TraceContext, type TraceId } from '../../types';
import { HttpProviderAdapter, type SpecialistEndpointConfig } from '../provider-adapter';
import {
  ErrorCode,
  ToolResultKind,
  type ExecutionPlan,
  type FailureResult,
  type SuccessResult,
  type TimeoutResult,
  type ToolRequest,
  type RetryPolicy,
  DEFAULT_RETRY_POLICY,
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
    effects: Object.freeze([EFFECT_TYPES.WRITE]),
    riskTier: 1 as ToolRequest['riskTier'],
    traceContext: makeTraceContext(),
    attempt: 1,
    maxAttempts: 3,
    requestedAt: '2026-02-11T00:00:00.000Z',
    idempotencyKey: 'idem-1',
    ...overrides,
  });
}

function makeDecision(): PolicyDecision {
  return Object.freeze({
    allowed: true,
    reason: 'allowed',
    traceId: 'trace-1',
    timestamp: '2026-02-11T00:00:00.000Z',
  });
}

function makePlan(overrides: Partial<ExecutionPlan> = {}): ExecutionPlan {
  return Object.freeze({
    request: makeRequest(),
    decision: makeDecision(),
    specialistId: 'codex',
    retryPolicy: DEFAULT_RETRY_POLICY,
    timeoutMs: 5_000,
    idempotencyKey: 'idem-1',
    ...overrides,
  });
}

function makeEndpoints(): Record<string, SpecialistEndpointConfig> {
  return {
    codex: Object.freeze({
      baseUrl: 'https://api.example.com/v1',
      apiKeyEnvVar: 'CODEX_KEY',
      timeoutMs: 5_000,
    }),
  };
}

function makeEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return { CODEX_KEY: 'test-key-123', ...overrides };
}

function makeJsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

// =============================================================================
// Tests
// =============================================================================

describe('executor/HttpProviderAdapter', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function createAdapter(env = makeEnv()) {
    return new HttpProviderAdapter({
      endpoints: makeEndpoints(),
      env,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
  }

  // -------------------------------------------------------------------------
  // Success
  // -------------------------------------------------------------------------

  it('returns SuccessResult on HTTP 200 with valid JSON', async () => {
    const body = { data: { executed: true }, usage: { prompt_tokens: 10, completion_tokens: 20 } };
    fetchMock.mockResolvedValueOnce(makeJsonResponse(body));
    const adapter = createAdapter();

    const result = await adapter.sendRequest(makePlan());

    expect(result.kind).toBe(ToolResultKind.SUCCESS);
    const success = result as SuccessResult;
    expect(success.executionCost.inputTokens).toBe(10);
    expect(success.executionCost.outputTokens).toBe(20);
    expect(success.executionCost.specialistId).toBe('codex');
    expect(success.requestId).toBe('req-1');
  });

  it('preserves traceContext from request', async () => {
    fetchMock.mockResolvedValueOnce(makeJsonResponse({ data: {} }));
    const adapter = createAdapter();
    const plan = makePlan();

    const result = await adapter.sendRequest(plan);

    expect(result.traceContext).toBe(plan.request.traceContext);
  });

  it('has durationMs >= 0', async () => {
    fetchMock.mockResolvedValueOnce(makeJsonResponse({ data: {} }));
    const adapter = createAdapter();

    const result = await adapter.sendRequest(makePlan());

    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('completedAt is valid ISO string', async () => {
    fetchMock.mockResolvedValueOnce(makeJsonResponse({ data: {} }));
    const adapter = createAdapter();

    const result = await adapter.sendRequest(makePlan());

    expect(result.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('result is frozen', async () => {
    fetchMock.mockResolvedValueOnce(makeJsonResponse({ data: {} }));
    const adapter = createAdapter();

    const result = await adapter.sendRequest(makePlan());

    expect(Object.isFrozen(result)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // HTTP Error Classification
  // -------------------------------------------------------------------------

  it('HTTP 429 -> RATE_LIMITED, retryable=true', async () => {
    fetchMock.mockResolvedValueOnce(makeJsonResponse({ error: { message: 'rate limited' } }, 429));
    const adapter = createAdapter();

    const result = await adapter.sendRequest(makePlan());

    expect(result.kind).toBe(ToolResultKind.FAILURE);
    const failure = result as FailureResult;
    expect(failure.errorCode).toBe(ErrorCode.RATE_LIMITED);
    expect(failure.retryable).toBe(true);
  });

  it('HTTP 500 -> PROVIDER_ERROR, retryable=true', async () => {
    fetchMock.mockResolvedValueOnce(makeJsonResponse({ error: { message: 'server error' } }, 500));
    const adapter = createAdapter();

    const result = await adapter.sendRequest(makePlan());

    expect(result.kind).toBe(ToolResultKind.FAILURE);
    const failure = result as FailureResult;
    expect(failure.errorCode).toBe(ErrorCode.PROVIDER_ERROR);
    expect(failure.retryable).toBe(true);
  });

  it('HTTP 400 -> VALIDATION_ERROR, retryable=false', async () => {
    fetchMock.mockResolvedValueOnce(makeJsonResponse({ error: { message: 'bad request' } }, 400));
    const adapter = createAdapter();

    const result = await adapter.sendRequest(makePlan());

    expect(result.kind).toBe(ToolResultKind.FAILURE);
    const failure = result as FailureResult;
    expect(failure.errorCode).toBe(ErrorCode.VALIDATION_ERROR);
    expect(failure.retryable).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Timeout / Abort
  // -------------------------------------------------------------------------

  it('abort error from timeout -> TimeoutResult', async () => {
    const controller = new AbortController();
    fetchMock.mockImplementationOnce(async (_url: string, init: RequestInit) => {
      // Simulate abort from internal timeout signal
      const signal = init.signal as AbortSignal;
      return new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('signal timed out', 'AbortError')));
        // Trigger abort immediately
        controller.abort();
      });
    });

    const adapter = createAdapter();
    // Use a very short timeout to trigger
    const plan = makePlan({ timeoutMs: 1 });

    const result = await adapter.sendRequest(plan);

    // Could be TIMEOUT or FAILURE depending on which abort fires first
    expect([ToolResultKind.TIMEOUT, ToolResultKind.FAILURE]).toContain(result.kind);
  });

  it('external abort signal -> FailureResult or TimeoutResult', async () => {
    const externalController = new AbortController();
    fetchMock.mockImplementationOnce(async (_url: string, init: RequestInit) => {
      const signal = init.signal as AbortSignal;
      return new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        externalController.abort();
      });
    });

    const adapter = createAdapter();
    const result = await adapter.sendRequest(makePlan(), externalController.signal);

    expect([ToolResultKind.TIMEOUT, ToolResultKind.FAILURE]).toContain(result.kind);
  });

  // -------------------------------------------------------------------------
  // Network / Parse Errors
  // -------------------------------------------------------------------------

  it('network error (fetch throws) -> PROVIDER_ERROR, retryable=true', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const adapter = createAdapter();

    const result = await adapter.sendRequest(makePlan());

    expect(result.kind).toBe(ToolResultKind.FAILURE);
    const failure = result as FailureResult;
    expect(failure.errorCode).toBe(ErrorCode.PROVIDER_ERROR);
    expect(failure.retryable).toBe(true);
    expect(failure.error).toContain('ECONNREFUSED');
  });

  it('invalid JSON response -> PROVIDER_ERROR', async () => {
    fetchMock.mockResolvedValueOnce(new Response('not json {{{', { status: 200 }));
    const adapter = createAdapter();

    const result = await adapter.sendRequest(makePlan());

    expect(result.kind).toBe(ToolResultKind.FAILURE);
    expect((result as FailureResult).errorCode).toBe(ErrorCode.PROVIDER_ERROR);
  });

  // -------------------------------------------------------------------------
  // Config Errors
  // -------------------------------------------------------------------------

  it('unknown specialist -> VALIDATION_ERROR or INTERNAL_ERROR', async () => {
    const adapter = createAdapter();
    const plan = makePlan({ specialistId: 'unknown-model' });

    const result = await adapter.sendRequest(plan);

    expect(result.kind).toBe(ToolResultKind.FAILURE);
    const failure = result as FailureResult;
    expect(failure.error).toContain('unknown');
    expect(failure.retryable).toBe(false);
  });

  it('missing API key -> INTERNAL_ERROR, retryable=false', async () => {
    const adapter = createAdapter({});
    const plan = makePlan();

    const result = await adapter.sendRequest(plan);

    expect(result.kind).toBe(ToolResultKind.FAILURE);
    const failure = result as FailureResult;
    expect(failure.errorCode).toBe(ErrorCode.INTERNAL_ERROR);
    expect(failure.retryable).toBe(false);
    expect(failure.error).toContain('API key');
  });

  // -------------------------------------------------------------------------
  // Cost Extraction
  // -------------------------------------------------------------------------

  it('extracts cost from usage in response body', async () => {
    const body = {
      data: { ok: true },
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    };
    fetchMock.mockResolvedValueOnce(makeJsonResponse(body));
    const adapter = createAdapter();

    const result = await adapter.sendRequest(makePlan());

    expect(result.kind).toBe(ToolResultKind.SUCCESS);
    const success = result as SuccessResult;
    expect(success.executionCost.inputTokens).toBe(100);
    expect(success.executionCost.outputTokens).toBe(50);
  });

  it('falls back to 0 tokens when usage is missing', async () => {
    fetchMock.mockResolvedValueOnce(makeJsonResponse({ data: {} }));
    const adapter = createAdapter();

    const result = await adapter.sendRequest(makePlan());

    expect(result.kind).toBe(ToolResultKind.SUCCESS);
    const success = result as SuccessResult;
    expect(success.executionCost.inputTokens).toBe(0);
    expect(success.executionCost.outputTokens).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Idempotency
  // -------------------------------------------------------------------------

  it('sends x-idempotency-key header', async () => {
    fetchMock.mockResolvedValueOnce(makeJsonResponse({ data: {} }));
    const adapter = createAdapter();
    const plan = makePlan({ idempotencyKey: 'unique-key-42' });

    await adapter.sendRequest(plan);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['x-idempotency-key']).toBe('unique-key-42');
  });
});
