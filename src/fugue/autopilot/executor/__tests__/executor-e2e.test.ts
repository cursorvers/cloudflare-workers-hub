/**
 * Wave 5: End-to-end integration test for the full Executor subsystem.
 *
 * Tests the complete pipeline: request → routing → adapter → retry → CB feedback → result.
 */

import { describe, expect, it, vi } from 'vitest';

import { createCircuitBreakerState, type CircuitBreakerState } from '../../runtime/circuit-breaker';
import type { SpecialistConfig, SpecialistRegistry } from '../../specialist/types';
import { EFFECT_TYPES, type SpanId, type TraceContext, type TraceId } from '../../types';
import { ExecutorWorker } from '../executor-worker';
import type { ProviderAdapter } from '../provider-adapter';
import {
  ErrorCode,
  ToolResultKind,
  freezeToolResult,
  type ToolRequest,
  type ToolResult,
} from '../types';

// =============================================================================
// Factories
// =============================================================================

function makeTraceContext(): TraceContext {
  return Object.freeze({
    traceId: 'trace-e2e' as TraceId,
    spanId: 'span-e2e' as SpanId,
    timestamp: '2026-02-12T00:00:00.000Z',
  });
}

function makeRequest(overrides: Partial<ToolRequest> = {}): ToolRequest {
  return Object.freeze({
    id: 'req-e2e',
    category: 'FILE_READ' as ToolRequest['category'],
    name: 'readFile',
    params: Object.freeze({ path: '/tmp/e2e.txt' }),
    effects: Object.freeze([EFFECT_TYPES.READ]),
    riskTier: 1 as ToolRequest['riskTier'],
    traceContext: makeTraceContext(),
    attempt: 1,
    maxAttempts: 3,
    requestedAt: '2026-02-12T00:00:00.000Z',
    idempotencyKey: 'idem-e2e',
    ...overrides,
  });
}

function makeRegistry(specialists?: readonly SpecialistConfig[]): SpecialistRegistry {
  return Object.freeze({
    specialists: Object.freeze(specialists ?? [
      Object.freeze({ id: 'codex', name: 'Codex', trustLevel: 'TRUSTED', maxRiskTier: 4, enabled: true } as SpecialistConfig),
      Object.freeze({ id: 'glm', name: 'GLM', trustLevel: 'TRUSTED', maxRiskTier: 4, enabled: true } as SpecialistConfig),
    ]),
  });
}

function makeSuccessResult(): ToolResult {
  return freezeToolResult({
    requestId: 'req-e2e',
    kind: ToolResultKind.SUCCESS,
    traceContext: makeTraceContext(),
    durationMs: 42,
    completedAt: '2026-02-12T00:00:01.000Z',
    data: Object.freeze({ response: 'file contents' }),
    executionCost: Object.freeze({
      inputTokens: 50, outputTokens: 100, estimatedCostUsd: 0, specialistId: 'glm', pricingTier: 'fixed' as const,
    }),
  });
}

function makeProviderError(): ToolResult {
  return freezeToolResult({
    requestId: 'req-e2e',
    kind: ToolResultKind.FAILURE,
    traceContext: makeTraceContext(),
    durationMs: 10,
    completedAt: '2026-02-12T00:00:01.000Z',
    errorCode: ErrorCode.PROVIDER_ERROR,
    error: 'HTTP 500: Internal Server Error',
    retryable: true,
  });
}

const allowedDecision = Object.freeze({
  allowed: true, reason: 'ok', traceId: 'trace-e2e', timestamp: '2026-02-12T00:00:00.000Z',
});

const deniedDecision = Object.freeze({
  allowed: false, reason: 'insufficient capability', traceId: 'trace-e2e', timestamp: '2026-02-12T00:00:00.000Z',
});

// =============================================================================
// E2E Tests
// =============================================================================

describe('executor/e2e integration', () => {
  it('happy path: routes to glm for FILE_READ and returns success', async () => {
    const sendRequest = vi.fn().mockResolvedValue(makeSuccessResult());
    const cbUpdates = new Map<string, CircuitBreakerState>();
    const worker = new ExecutorWorker({
      adapter: { sendRequest } as ProviderAdapter,
      registry: makeRegistry(),
      mode: 'NORMAL',
      circuitStates: new Map([
        ['codex', createCircuitBreakerState()],
        ['glm', createCircuitBreakerState()],
      ]),
      weeklyCount: new Map(),
      onCircuitUpdate: (id, state) => cbUpdates.set(id, state),
    });

    const result = await worker.execute(makeRequest(), allowedDecision);

    expect(result.kind).toBe(ToolResultKind.SUCCESS);
    // glm should be preferred for FILE_READ (category bonus)
    const plan = sendRequest.mock.calls[0][0];
    expect(plan.specialistId).toBe('glm');
    // CB should be updated for glm
    expect(cbUpdates.get('glm')?.totalSuccesses).toBe(1);
  });

  it('policy denial short-circuits without calling adapter', async () => {
    const sendRequest = vi.fn();
    const worker = new ExecutorWorker({
      adapter: { sendRequest } as ProviderAdapter,
      registry: makeRegistry(),
      mode: 'NORMAL',
      circuitStates: new Map(),
      weeklyCount: new Map(),
    });

    const result = await worker.execute(makeRequest(), deniedDecision);

    expect(result.kind).toBe(ToolResultKind.DENIED);
    expect(sendRequest).not.toHaveBeenCalled();
  });

  it('STOPPED mode blocks all routing', async () => {
    const sendRequest = vi.fn();
    const worker = new ExecutorWorker({
      adapter: { sendRequest } as ProviderAdapter,
      registry: makeRegistry(),
      mode: 'STOPPED',
      circuitStates: new Map(),
      weeklyCount: new Map(),
    });

    const result = await worker.execute(makeRequest(), allowedDecision);

    expect(result.kind).toBe(ToolResultKind.FAILURE);
    expect((result as { error: string }).error).toContain('routing failed');
    expect(sendRequest).not.toHaveBeenCalled();
  });

  it('DEGRADED mode filters to TRUSTED specialists only', async () => {
    const sendRequest = vi.fn().mockResolvedValue(makeSuccessResult());
    const registry = makeRegistry([
      Object.freeze({ id: 'codex', name: 'Codex', trustLevel: 'TRUSTED', maxRiskTier: 4, enabled: true } as SpecialistConfig),
      Object.freeze({ id: 'gemini', name: 'Gemini', trustLevel: 'UNTRUSTED', maxRiskTier: 4, enabled: true } as SpecialistConfig),
    ]);
    const worker = new ExecutorWorker({
      adapter: { sendRequest } as ProviderAdapter,
      registry,
      mode: 'DEGRADED',
      circuitStates: new Map([['codex', createCircuitBreakerState()]]),
      weeklyCount: new Map(),
    });

    const result = await worker.execute(makeRequest(), allowedDecision);

    expect(result.kind).toBe(ToolResultKind.SUCCESS);
    const plan = sendRequest.mock.calls[0][0];
    expect(plan.specialistId).toBe('codex');
  });

  it('retry + CB: provider error → retry → success → CB updated', async () => {
    const sendRequest = vi.fn()
      .mockResolvedValueOnce(makeProviderError())
      .mockResolvedValueOnce(makeSuccessResult());
    const cbUpdates: Array<{ id: string; state: CircuitBreakerState }> = [];
    const worker = new ExecutorWorker({
      adapter: { sendRequest } as ProviderAdapter,
      registry: makeRegistry(),
      mode: 'NORMAL',
      circuitStates: new Map([['glm', createCircuitBreakerState()]]),
      weeklyCount: new Map(),
      onCircuitUpdate: (id, state) => cbUpdates.push({ id, state }),
    });

    const result = await worker.execute(makeRequest(), allowedDecision);

    expect(result.kind).toBe(ToolResultKind.SUCCESS);
    expect(sendRequest).toHaveBeenCalledTimes(2);
    // Final CB update should record success
    const finalUpdate = cbUpdates[cbUpdates.length - 1];
    expect(finalUpdate.state.totalSuccesses).toBe(1);
  });

  it('all retries fail → CB records failure', async () => {
    const sendRequest = vi.fn().mockResolvedValue(makeProviderError());
    const cbUpdates: Array<{ id: string; state: CircuitBreakerState }> = [];
    const worker = new ExecutorWorker({
      adapter: { sendRequest } as ProviderAdapter,
      registry: makeRegistry(),
      mode: 'NORMAL',
      circuitStates: new Map([['glm', createCircuitBreakerState()]]),
      weeklyCount: new Map(),
      onCircuitUpdate: (id, state) => cbUpdates.push({ id, state }),
    });

    const result = await worker.execute(makeRequest(), allowedDecision);

    expect(result.kind).toBe(ToolResultKind.FAILURE);
    expect(sendRequest).toHaveBeenCalledTimes(3); // maxAttempts=3
    // CB should record failure
    const finalUpdate = cbUpdates[cbUpdates.length - 1];
    expect(finalUpdate.state.totalFailures).toBe(1);
    expect(finalUpdate.state.consecutiveFailures).toBe(1);
  });

  it('full pipeline results are immutable', async () => {
    const sendRequest = vi.fn().mockResolvedValue(makeSuccessResult());
    const worker = new ExecutorWorker({
      adapter: { sendRequest } as ProviderAdapter,
      registry: makeRegistry(),
      mode: 'NORMAL',
      circuitStates: new Map(),
      weeklyCount: new Map(),
    });

    const success = await worker.execute(makeRequest(), allowedDecision);
    const denied = await worker.execute(makeRequest(), deniedDecision);

    expect(Object.isFrozen(success)).toBe(true);
    expect(Object.isFrozen(denied)).toBe(true);
  });
});
