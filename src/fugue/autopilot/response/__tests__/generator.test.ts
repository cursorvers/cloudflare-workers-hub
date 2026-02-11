import { describe, expect, it } from 'vitest';

import type { ToolResult } from '../../executor/types';
import type { RiskTier, SpanId, TraceContext, TraceId } from '../../types';
import type { UxResponse } from '../../ux/types';
import { generateResponse } from '../generator';

function makeTraceContext(overrides: Partial<TraceContext> = {}): TraceContext {
  const base: TraceContext = {
    traceId: 'trace-1' as TraceId,
    spanId: 'span-1' as SpanId,
    timestamp: '2026-02-11T00:00:00.000Z',
  };
  return Object.freeze({ ...base, ...overrides });
}

function makeUxResponse(overrides: Partial<UxResponse> = {}): UxResponse {
  const base: UxResponse = {
    action: 'auto-execute',
    reason: 'tier 1 allowed',
    alternatives: Object.freeze([]),
    requiresUserInput: false,
    riskTier: 1,
  };
  return Object.freeze({ ...base, ...overrides });
}

function makeToolResult(overrides: Partial<ToolResult> = {}): ToolResult {
  const base: ToolResult = {
    requestId: 'req-1',
    status: 'success',
    data: Object.freeze({ tool: 'readFile' }),
    traceContext: makeTraceContext(),
    durationMs: 5,
  };
  return Object.freeze({ ...base, ...overrides });
}

describe('response/generateResponse', () => {
  it("a. auto-execute + success -> 'executed'", () => {
    const response = generateResponse(makeUxResponse(), makeToolResult(), 'trace-1');
    expect(response.status).toBe('executed');
    expect(response.summary).toContain('readFile');
  });

  it("b. auto-execute + failure -> 'error' with error message", () => {
    const response = generateResponse(
      makeUxResponse(),
      makeToolResult({ status: 'failure', error: 'mock execution failed', data: undefined }),
      'trace-1',
    );
    expect(response.status).toBe('error');
    expect(response.details).toContain('mock execution failed');
  });

  it("c. confirm-card -> 'needs-input' with requiresUserInput intent", () => {
    const ux = makeUxResponse({ action: 'confirm-card', reason: 'tier 2 requires confirmation', requiresUserInput: true });
    const response = generateResponse(ux, null, 'trace-2');
    expect(response.status).toBe('needs-input');
    expect(response.details).toContain('User confirmation is required');
  });

  it("d. human-approval -> 'needs-input'", () => {
    const ux = makeUxResponse({ action: 'human-approval', reason: 'tier 3 requires approval', riskTier: 3, requiresUserInput: true });
    const response = generateResponse(ux, null, 'trace-3');
    expect(response.status).toBe('needs-input');
    expect(response.details).toContain('Tier 3 approval');
  });

  it("e. blocked -> 'denied' with alternatives (never empty)", () => {
    const ux = makeUxResponse({ action: 'blocked', reason: 'blocked by policy', requiresUserInput: false });
    const response = generateResponse(ux, null, 'trace-4');
    expect(response.status).toBe('denied');
    expect(response.alternatives.length).toBeGreaterThan(0);
  });

  it('f. blocked with budget reason -> budget-specific alternatives', () => {
    const ux = makeUxResponse({ action: 'blocked', reason: 'budget halted', riskTier: 2 });
    const response = generateResponse(ux, null, 'trace-5');
    const descriptions = response.alternatives.map((item) => item.description);
    expect(descriptions).toContain('wait for budget reset');
    expect(descriptions).toContain('request read-only operation');
  });

  it('g. blocked with circuit breaker -> recovery alternatives', () => {
    const ux = makeUxResponse({ action: 'blocked', reason: 'circuit breaker is open' });
    const response = generateResponse(ux, null, 'trace-6');
    const descriptions = response.alternatives.map((item) => item.description);
    expect(descriptions).toContain('wait for recovery');
    expect(descriptions).toContain('check system status');
  });

  it('h. alternatives from policy decision are included', () => {
    const ux = makeUxResponse({
      action: 'blocked',
      reason: 'policy deny',
      alternatives: Object.freeze(['use read-only mode', 'request limited capability']),
      riskTier: 2,
    });
    const response = generateResponse(ux, null, 'trace-7');
    const descriptions = response.alternatives.map((item) => item.description);
    expect(descriptions).toContain('use read-only mode');
    expect(descriptions).toContain('request limited capability');
  });

  it('i. all responses are frozen', () => {
    const response = generateResponse(makeUxResponse({ action: 'blocked', reason: 'policy deny' }), null, 'trace-8');
    expect(Object.isFrozen(response)).toBe(true);
    expect(Object.isFrozen(response.alternatives)).toBe(true);
    if (response.alternatives.length > 0) expect(Object.isFrozen(response.alternatives[0])).toBe(true);
  });

  it('j. traceId and timestamp are present', () => {
    const response = generateResponse(makeUxResponse(), makeToolResult(), 'trace-present');
    expect(response.traceId).toBe('trace-present');
    expect(response.timestamp.length).toBeGreaterThan(0);
  });

  it('sets deterministic fallback timestamp when toolResult is null', () => {
    const response = generateResponse(makeUxResponse({ action: 'blocked', reason: 'policy deny' }), null, 'trace-9');
    expect(response.timestamp).toBe('1970-01-01T00:00:00.000Z');
  });

  it('marks high-tier alternatives as requiring approval', () => {
    const ux = makeUxResponse({
      action: 'blocked',
      reason: 'policy deny',
      alternatives: Object.freeze(['request limited capability']),
      riskTier: 3 as RiskTier,
    });
    const response = generateResponse(ux, null, 'trace-10');
    expect(response.alternatives[0]?.requiresApproval).toBe(true);
  });
});
