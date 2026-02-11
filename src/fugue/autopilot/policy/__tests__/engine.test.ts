import { describe, expect, it, vi, afterEach } from 'vitest';

import {
  BUDGET_STATES,
  EFFECT_TYPES,
  ORIGINS,
  SUBJECT_TYPES,
  TRUST_ZONES,
  type TraceContext,
  type TraceId,
  type SpanId,
} from '../../types';

import { DEFAULT_RULES } from '../rules';
import { createCapability } from '../capability';
import { evaluatePolicy } from '../engine';
import type { Capability, PolicyContext, PolicyRule } from '../types';

afterEach(() => {
  vi.useRealTimers();
});

function makeTraceContext(overrides: Partial<TraceContext> = {}): TraceContext {
  const base: TraceContext = {
    traceId: 'trace-1' as TraceId,
    spanId: 'span-1' as SpanId,
    timestamp: '2026-02-11T00:00:00.000Z',
  };
  return Object.freeze({ ...base, ...overrides });
}

function makeCtx(overrides: Partial<PolicyContext> = {}): PolicyContext {
  const base: PolicyContext = {
    subject: Object.freeze({ id: 'u1', type: SUBJECT_TYPES.USER }),
    origin: ORIGINS.CLI,
    effects: Object.freeze([]),
    riskTier: 0,
    trustZone: TRUST_ZONES.USER_INTENT,
    budgetState: BUDGET_STATES.NORMAL,
    traceContext: makeTraceContext(),
  };
  return Object.freeze({ ...base, ...overrides });
}

describe('policy/engine.evaluatePolicy', () => {
  it('denies by default when no rule matches', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-11T01:00:00.000Z'));

    const ctx = makeCtx({
      origin: ORIGINS.WEBHOOK,
      effects: Object.freeze([EFFECT_TYPES.WRITE]),
      riskTier: 1,
    });

    const d = evaluatePolicy(ctx, DEFAULT_RULES, []);

    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('no matching rule');
    expect(d.traceId).toBe('trace-1');
    expect(d.timestamp).toBe('2026-02-11T01:00:00.000Z');
  });

  it('denies when budget is HALTED', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-11T02:00:00.000Z'));

    const ctx = makeCtx({ budgetState: BUDGET_STATES.HALTED });
    const d = evaluatePolicy(ctx, DEFAULT_RULES, []);

    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('budget halted');
  });

  it('denies WRITE when budget is DEGRADED (read-only)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-11T03:00:00.000Z'));

    const ctx = makeCtx({
      budgetState: BUDGET_STATES.DEGRADED,
      effects: Object.freeze([EFFECT_TYPES.WRITE]),
      riskTier: 1,
    });

    const d = evaluatePolicy(ctx, DEFAULT_RULES, []);

    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('read-only in degraded budget state');
  });

  it('denies external origins for Tier3+ regardless of rules/capabilities', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-11T04:00:00.000Z'));

    const ctx = makeCtx({
      origin: ORIGINS.GITHUB_PR,
      effects: Object.freeze([EFFECT_TYPES.EXEC]),
      riskTier: 3,
    });

    const cap = createCapability({
      id: 'cap-1',
      subjectId: 'u1',
      effects: [EFFECT_TYPES.EXEC],
      maxTier: 3,
      origins: [ORIGINS.GITHUB_PR],
      expiresAt: '2026-02-12T00:00:00.000Z',
      maxUses: 1,
    });

    const d = evaluatePolicy(ctx, DEFAULT_RULES, [cap]);

    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('external origin exceeds max tier (maxTier=2)');
  });

  it('requires a valid capability for Tier3', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-11T05:00:00.000Z'));

    const ctx = makeCtx({
      origin: ORIGINS.CLI,
      effects: Object.freeze([EFFECT_TYPES.EXFIL]),
      riskTier: 3,
    });

    const dNoCap = evaluatePolicy(ctx, DEFAULT_RULES, []);
    expect(dNoCap.allowed).toBe(false);
    expect(dNoCap.reason).toBe('capability required');
    expect(dNoCap.alternatives).toEqual(['request a bounded capability']);

    const cap = createCapability({
      id: 'cap-2',
      subjectId: 'u1',
      effects: [EFFECT_TYPES.EXFIL],
      maxTier: 3,
      origins: [ORIGINS.CLI],
      expiresAt: '2026-02-12T00:00:00.000Z',
      maxUses: 2,
    });

    const dCap = evaluatePolicy(ctx, DEFAULT_RULES, [cap]);
    expect(dCap.allowed).toBe(true);
    expect(dCap.reason).toContain('allowed');
  });

  it('treats expired or exhausted capabilities as invalid (deny)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-11T06:00:00.000Z'));

    const ctx = makeCtx({
      origin: ORIGINS.CLI,
      effects: Object.freeze([EFFECT_TYPES.SECRET_READ]),
      riskTier: 3,
    });

    const expired = createCapability({
      id: 'cap-expired',
      subjectId: 'u1',
      effects: [EFFECT_TYPES.SECRET_READ],
      maxTier: 3,
      origins: [ORIGINS.CLI],
      expiresAt: '2026-02-11T05:59:59.999Z',
      maxUses: 1,
    });

    const exhausted: Capability = Object.freeze({
      ...expired,
      id: 'cap-exhausted',
      expiresAt: '2026-02-12T00:00:00.000Z',
      usedCount: 1,
      maxUses: 1,
    });

    const d1 = evaluatePolicy(ctx, DEFAULT_RULES, [expired]);
    expect(d1.allowed).toBe(false);
    expect(d1.reason).toBe('capability required');

    const d2 = evaluatePolicy(ctx, DEFAULT_RULES, [exhausted]);
    expect(d2.allowed).toBe(false);
    expect(d2.reason).toBe('capability required');
  });

  it('always denies on internal error (e.g., rule condition throws)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-11T07:00:00.000Z'));

    const ctx = makeCtx({ effects: Object.freeze([]), riskTier: 0 });

    const badRule: PolicyRule = Object.freeze({
      id: 'bad-rule',
      description: 'throws',
      effects: Object.freeze([]),
      maxTier: 0,
      origins: Object.freeze([ORIGINS.CLI]),
      subjectTypes: Object.freeze([SUBJECT_TYPES.USER]),
      condition: () => {
        throw new Error('boom');
      },
    });

    const d = evaluatePolicy(ctx, [badRule], []);
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('internal error: boom');
  });
});

