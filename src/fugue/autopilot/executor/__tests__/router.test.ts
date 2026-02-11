import { describe, expect, it } from 'vitest';

import type { CircuitBreakerState } from '../../runtime/circuit-breaker';
import type { ExtendedMode } from '../../runtime/coordinator';
import type { SpecialistConfig, SpecialistRegistry } from '../../specialist/types';
import { EFFECT_TYPES, type SpanId, type TraceContext, type TraceId } from '../../types';
import { routeSpecialist } from '../router';
import { ToolCategory, type ToolRequest } from '../types';

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
    params: Object.freeze({ path: '/tmp/file.txt' }),
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

function makeRegistry(specialists: readonly SpecialistConfig[]): SpecialistRegistry {
  return Object.freeze({ specialists: Object.freeze([...specialists]) });
}

function makeSpecialist(overrides: Partial<SpecialistConfig> = {}): SpecialistConfig {
  const base: SpecialistConfig = {
    id: 'codex',
    name: 'Codex',
    trustLevel: 'TRUSTED',
    maxRiskTier: 4,
    enabled: true,
  };
  return Object.freeze({ ...base, ...overrides });
}

function makeCircuitState(state: CircuitBreakerState['state']): CircuitBreakerState {
  return Object.freeze({
    state,
    consecutiveFailures: 0,
    lastFailureMs: null,
    totalFailures: 0,
    totalSuccesses: 0,
  });
}

function route(
  request: ToolRequest,
  mode: ExtendedMode,
  registry: SpecialistRegistry,
  circuitStates: ReadonlyMap<string, CircuitBreakerState> = new Map(),
  weeklyCount: ReadonlyMap<string, number> = new Map(),
) {
  return routeSpecialist(request, mode, circuitStates, weeklyCount, registry);
}

describe('executor/router.routeSpecialist', () => {
  it('Mode Gate: STOPPED => status=mode-blocked', () => {
    const result = route(
      makeRequest(),
      'STOPPED',
      makeRegistry([makeSpecialist({ id: 'glm', name: 'GLM' })]),
    );

    expect(result.status).toBe('mode-blocked');
    expect(result.specialistId).toBe('');
  });

  it('Mode Gate: NORMAL => routing proceeds', () => {
    const registry = makeRegistry([
      makeSpecialist({ id: 'codex', name: 'Codex', maxRiskTier: 4 }),
      makeSpecialist({ id: 'glm', name: 'GLM', maxRiskTier: 4 }),
    ]);
    const result = route(makeRequest({ category: ToolCategory.FILE_READ }), 'NORMAL', registry);

    expect(result.status).toBe('routed');
    expect(result.specialistId).toBe('glm');
  });

  it('Mode Gate: DEGRADED => TRUSTED only', () => {
    const registry = makeRegistry([
      makeSpecialist({ id: 'codex', trustLevel: 'TRUSTED', maxRiskTier: 4 }),
      makeSpecialist({ id: 'gemini', trustLevel: 'UNTRUSTED', maxRiskTier: 4 }),
    ]);
    const result = route(
      makeRequest({ category: ToolCategory.FILE_WRITE, riskTier: 4 }),
      'DEGRADED',
      registry,
    );

    expect(result.status).toBe('routed');
    expect(result.specialistId).toBe('codex');
  });

  it('Mode Gate: RECOVERY => TRUSTED only', () => {
    const registry = makeRegistry([
      makeSpecialist({ id: 'codex', trustLevel: 'TRUSTED', maxRiskTier: 4 }),
      makeSpecialist({ id: 'glm', trustLevel: 'SEMI_TRUSTED', maxRiskTier: 4 }),
    ]);
    const result = route(
      makeRequest({ category: ToolCategory.FILE_WRITE, riskTier: 2 }),
      'RECOVERY',
      registry,
    );

    expect(result.status).toBe('routed');
    expect(result.specialistId).toBe('codex');
  });

  it('Trust + Risk Tier: riskTier=4 and only codex matches => codex routed', () => {
    const registry = makeRegistry([
      makeSpecialist({ id: 'codex', maxRiskTier: 4 }),
      makeSpecialist({ id: 'glm', maxRiskTier: 2 }),
      makeSpecialist({ id: 'gemini', maxRiskTier: 2 }),
    ]);
    const result = route(makeRequest({ riskTier: 4, category: ToolCategory.FILE_WRITE }), 'NORMAL', registry);

    expect(result.status).toBe('routed');
    expect(result.specialistId).toBe('codex');
  });

  it('Trust + Risk Tier: riskTier=2 with glm+gemini => glm preferred (cost)', () => {
    const registry = makeRegistry([
      makeSpecialist({ id: 'glm', maxRiskTier: 2 }),
      makeSpecialist({ id: 'gemini', maxRiskTier: 2 }),
    ]);
    const result = route(makeRequest({ riskTier: 2, category: ToolCategory.FILE_WRITE }), 'NORMAL', registry);

    expect(result.status).toBe('routed');
    expect(result.specialistId).toBe('glm');
  });

  it('Trust + Risk Tier: riskTier=5 => no-match', () => {
    const registry = makeRegistry([
      makeSpecialist({ id: 'codex', maxRiskTier: 4 }),
      makeSpecialist({ id: 'glm', maxRiskTier: 2 }),
      makeSpecialist({ id: 'gemini', maxRiskTier: 2 }),
    ]);
    const result = route(
      makeRequest({ riskTier: 5 as unknown as ToolRequest['riskTier'] }),
      'NORMAL',
      registry,
    );

    expect(result.status).toBe('no-match');
    expect(result.specialistId).toBe('');
  });

  it('Circuit Breaker: all eligible OPEN => all-open + alternatives', () => {
    const registry = makeRegistry([
      makeSpecialist({ id: 'codex', maxRiskTier: 4 }),
      makeSpecialist({ id: 'glm', maxRiskTier: 4 }),
    ]);
    const circuitStates = new Map<string, CircuitBreakerState>([
      ['codex', makeCircuitState('OPEN')],
      ['glm', makeCircuitState('OPEN')],
    ]);
    const result = route(makeRequest({ riskTier: 1 }), 'NORMAL', registry, circuitStates);

    expect(result.status).toBe('all-open');
    expect(result.alternatives).toEqual(['codex', 'glm']);
  });

  it('Circuit Breaker: one OPEN, one CLOSED => CLOSED one routed', () => {
    const registry = makeRegistry([
      makeSpecialist({ id: 'codex', maxRiskTier: 4 }),
      makeSpecialist({ id: 'glm', maxRiskTier: 4 }),
    ]);
    const circuitStates = new Map<string, CircuitBreakerState>([
      ['glm', makeCircuitState('OPEN')],
      ['codex', makeCircuitState('CLOSED')],
    ]);
    const result = route(makeRequest({ category: ToolCategory.FILE_READ }), 'NORMAL', registry, circuitStates);

    expect(result.status).toBe('routed');
    expect(result.specialistId).toBe('codex');
  });

  it('Circuit Breaker: default (no entry) => treated as CLOSED', () => {
    const registry = makeRegistry([makeSpecialist({ id: 'codex', maxRiskTier: 4 })]);
    const result = route(makeRequest(), 'NORMAL', registry, new Map());

    expect(result.status).toBe('routed');
    expect(result.specialistId).toBe('codex');
  });

  it('Rate Limit: all exceeded => no-match + alternatives', () => {
    const registry = makeRegistry([
      makeSpecialist({ id: 'codex', maxRiskTier: 4 }),
      makeSpecialist({ id: 'glm', maxRiskTier: 4 }),
    ]);
    const weeklyCount = new Map<string, number>([
      ['codex', 150],
      ['glm', 150],
    ]);
    const result = route(makeRequest(), 'NORMAL', registry, new Map(), weeklyCount);

    expect(result.status).toBe('no-match');
    expect(result.alternatives).toEqual(['codex', 'glm']);
  });

  it('Rate Limit: one exceeded, one ok => ok one routed', () => {
    const registry = makeRegistry([
      makeSpecialist({ id: 'codex', maxRiskTier: 4 }),
      makeSpecialist({ id: 'glm', maxRiskTier: 4 }),
    ]);
    const weeklyCount = new Map<string, number>([
      ['codex', 150],
      ['glm', 149],
    ]);
    const result = route(
      makeRequest({ category: ToolCategory.FILE_WRITE }),
      'NORMAL',
      registry,
      new Map(),
      weeklyCount,
    );

    expect(result.status).toBe('routed');
    expect(result.specialistId).toBe('glm');
  });

  it('Category Bonus: FILE_WRITE => codex preferred (bonus 2)', () => {
    const registry = makeRegistry([
      makeSpecialist({ id: 'codex', maxRiskTier: 4 }),
      makeSpecialist({ id: 'glm', maxRiskTier: 4 }),
    ]);
    const result = route(makeRequest({ category: ToolCategory.FILE_WRITE }), 'NORMAL', registry);

    expect(result.specialistId).toBe('codex');
  });

  it('Category Bonus: FILE_READ => glm preferred (bonus 2)', () => {
    const registry = makeRegistry([
      makeSpecialist({ id: 'codex', maxRiskTier: 4 }),
      makeSpecialist({ id: 'glm', maxRiskTier: 4 }),
    ]);
    const result = route(makeRequest({ category: ToolCategory.FILE_READ }), 'NORMAL', registry);

    expect(result.specialistId).toBe('glm');
  });

  it('Category Bonus: NETWORK => glm preferred (bonus 2)', () => {
    const registry = makeRegistry([
      makeSpecialist({ id: 'codex', maxRiskTier: 4 }),
      makeSpecialist({ id: 'glm', maxRiskTier: 4 }),
    ]);
    const result = route(makeRequest({ category: ToolCategory.NETWORK }), 'NORMAL', registry);

    expect(result.specialistId).toBe('glm');
  });

  it('Tie-breaking by cost: glm > codex > gemini (when bonus tie)', () => {
    const tieForCodexGemini = makeRegistry([
      makeSpecialist({ id: 'codex', maxRiskTier: 4 }),
      makeSpecialist({ id: 'gemini', maxRiskTier: 4 }),
    ]);
    const codexVsGemini = route(
      makeRequest({ category: ToolCategory.FILE_READ }),
      'NORMAL',
      tieForCodexGemini,
    );

    const tieForGlmGemini = makeRegistry([
      makeSpecialist({ id: 'glm', maxRiskTier: 4 }),
      makeSpecialist({ id: 'gemini', maxRiskTier: 4 }),
    ]);
    const glmVsGemini = route(
      makeRequest({ category: ToolCategory.FILE_WRITE }),
      'NORMAL',
      tieForGlmGemini,
    );

    expect(codexVsGemini.specialistId).toBe('codex');
    expect(glmVsGemini.specialistId).toBe('glm');
  });

  it('Result Properties: results are frozen', () => {
    const registry = makeRegistry([
      makeSpecialist({ id: 'glm', maxRiskTier: 4 }),
      makeSpecialist({ id: 'codex', maxRiskTier: 4 }),
      makeSpecialist({ id: 'gemini', maxRiskTier: 4 }),
    ]);
    const result = route(makeRequest({ category: ToolCategory.FILE_READ }), 'NORMAL', registry);

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.alternatives)).toBe(true);
  });

  it('Result Properties: alternatives list excludes winner', () => {
    const registry = makeRegistry([
      makeSpecialist({ id: 'glm', maxRiskTier: 4 }),
      makeSpecialist({ id: 'codex', maxRiskTier: 4 }),
      makeSpecialist({ id: 'gemini', maxRiskTier: 4 }),
    ]);
    const result = route(makeRequest({ category: ToolCategory.FILE_READ }), 'NORMAL', registry);

    expect(result.status).toBe('routed');
    expect(result.alternatives).not.toContain(result.specialistId);
    expect(result.alternatives).toEqual(['codex', 'gemini']);
  });

  it('Result Properties: reason includes category and riskTier', () => {
    const registry = makeRegistry([
      makeSpecialist({ id: 'glm', maxRiskTier: 4 }),
      makeSpecialist({ id: 'codex', maxRiskTier: 4 }),
    ]);
    const request = makeRequest({ category: ToolCategory.NETWORK, riskTier: 2 });
    const result = route(request, 'NORMAL', registry);

    expect(result.reason).toContain(`category=${request.category}`);
    expect(result.reason).toContain(`riskTier=${request.riskTier}`);
  });
});
