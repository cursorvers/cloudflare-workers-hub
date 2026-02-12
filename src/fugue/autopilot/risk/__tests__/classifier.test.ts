import { describe, expect, it } from 'vitest';

import { ToolCategory, type ToolRequest } from '../../executor/types';
import {
  EFFECT_TYPES,
  ORIGINS,
  SUBJECT_TYPES,
  type EffectType,
  type SpanId,
  type TraceContext,
  type TraceId,
} from '../../types';

import { classifyRisk, classifyToolRequest, EFFECT_TIER_MAP, CATEGORY_ESCALATION } from '../classifier';

function makeTraceContext(overrides: Partial<TraceContext> = {}): TraceContext {
  const base: TraceContext = {
    traceId: 'trace-risk-1' as TraceId,
    spanId: 'span-risk-1' as SpanId,
    timestamp: '2026-02-11T00:00:00.000Z',
  };
  return Object.freeze({ ...base, ...overrides });
}

function makeToolRequest(overrides: Partial<ToolRequest> = {}): ToolRequest {
  const base: ToolRequest = {
    id: 'req-1',
    category: ToolCategory.FILE_READ,
    name: 'readFile',
    params: Object.freeze({ path: '/tmp/file' }),
    effects: Object.freeze([]),
    riskTier: 0,
    traceContext: makeTraceContext(),
  };
  return Object.freeze({ ...base, ...overrides });
}

describe('risk/classifier.classifyRisk', () => {
  it('a. no effects => Tier 0', () => {
    expect(
      classifyRisk({ effects: Object.freeze([]), category: ToolCategory.FILE_READ, origin: ORIGINS.CLI }),
    ).toBe(0);
  });

  it('b. WRITE only + FILE_WRITE => Tier 1', () => {
    expect(
      classifyRisk({
        effects: Object.freeze(['WRITE' as EffectType]),
        category: ToolCategory.FILE_WRITE,
        origin: ORIGINS.CLI,
      }),
    ).toBe(1);
  });

  it('c. WRITE only + DEPLOY => Tier 3', () => {
    expect(
      classifyRisk({
        effects: Object.freeze(['WRITE' as EffectType]),
        category: ToolCategory.DEPLOY,
        origin: ORIGINS.CLI,
      }),
    ).toBe(3);
  });

  it('d. PRIV_CHANGE => Tier 3', () => {
    expect(
      classifyRisk({
        effects: Object.freeze(['PRIV_CHANGE' as EffectType]),
        category: ToolCategory.FILE_READ,
        origin: ORIGINS.CLI,
      }),
    ).toBe(3);
  });

  it('e. SECRET_READ => Tier 3', () => {
    expect(
      classifyRisk({
        effects: Object.freeze(['SECRET_READ' as EffectType]),
        category: ToolCategory.FILE_READ,
        origin: ORIGINS.CLI,
      }),
    ).toBe(3);
  });

  it('f. EXFIL => Tier 4', () => {
    expect(
      classifyRisk({
        effects: Object.freeze(['EXFIL' as EffectType]),
        category: ToolCategory.FILE_READ,
        origin: ORIGINS.CLI,
      }),
    ).toBe(4);
  });

  it('g. EXEC => Tier 3', () => {
    expect(
      classifyRisk({
        effects: Object.freeze(['EXEC' as EffectType]),
        category: ToolCategory.FILE_READ,
        origin: ORIGINS.CLI,
      }),
    ).toBe(3);
  });

  it('h. EXEC + DEPLOY => Tier 3', () => {
    expect(
      classifyRisk({
        effects: Object.freeze(['EXEC' as EffectType]),
        category: ToolCategory.DEPLOY,
        origin: ORIGINS.CLI,
      }),
    ).toBe(3);
  });

  it('i. WRITE + EXFIL => Tier 4', () => {
    expect(
      classifyRisk({
        effects: Object.freeze(['WRITE', 'EXFIL'] as EffectType[]),
        category: ToolCategory.FILE_WRITE,
        origin: ORIGINS.CLI,
      }),
    ).toBe(4);
  });

  it('j. GIT + WRITE => Tier 1', () => {
    expect(
      classifyRisk({
        effects: Object.freeze(['WRITE' as EffectType]),
        category: ToolCategory.GIT,
        origin: ORIGINS.CLI,
      }),
    ).toBe(1);
  });

  it('k. SHELL + no effects => Tier 2', () => {
    expect(
      classifyRisk({
        effects: Object.freeze([]),
        category: ToolCategory.SHELL,
        origin: ORIGINS.CLI,
      }),
    ).toBe(2);
  });

  it('fails closed for unknown effect => Tier 4', () => {
    const unknownEffect = ['UNKNOWN_EFFECT'] as unknown as readonly EffectType[];
    expect(
      classifyRisk({
        effects: unknownEffect,
        category: ToolCategory.FILE_READ,
        origin: ORIGINS.CLI,
      }),
    ).toBe(4);
  });

  it('m. tier is monotonic: adding effects never decreases tier', () => {
    const category = ToolCategory.FILE_READ;
    const base = classifyRisk({ effects: Object.freeze(['WRITE' as EffectType]), category, origin: ORIGINS.CLI });
    const plusExec = classifyRisk({
      effects: Object.freeze(['WRITE', 'EXEC'] as EffectType[]),
      category,
      origin: ORIGINS.CLI,
    });
    const plusExfil = classifyRisk({
      effects: Object.freeze(['WRITE', 'EXEC', 'EXFIL'] as EffectType[]),
      category,
      origin: ORIGINS.CLI,
    });

    expect(base).toBeLessThanOrEqual(plusExec);
    expect(plusExec).toBeLessThanOrEqual(plusExfil);
  });
});

// =============================================================================
// Release Gate: Enum Consistency Checks
// =============================================================================

describe('risk/classifier release gate: enum consistency', () => {
  it('every EFFECT_TYPES value has an entry in EFFECT_TIER_MAP', () => {
    const effectValues = Object.values(EFFECT_TYPES);
    const mapKeys = Object.keys(EFFECT_TIER_MAP);

    for (const effect of effectValues) {
      expect(mapKeys, `EFFECT_TIER_MAP missing entry for '${effect}'`).toContain(effect);
    }
  });

  it('every EFFECT_TIER_MAP key is a valid EFFECT_TYPES value', () => {
    const effectValues = new Set(Object.values(EFFECT_TYPES));
    const mapKeys = Object.keys(EFFECT_TIER_MAP);

    for (const key of mapKeys) {
      expect(effectValues.has(key as EffectType), `Stale EFFECT_TIER_MAP entry '${key}'`).toBe(true);
    }
  });

  it('EFFECT_TIER_MAP has exact same size as EFFECT_TYPES', () => {
    const effectCount = Object.values(EFFECT_TYPES).length;
    const mapCount = Object.keys(EFFECT_TIER_MAP).length;
    expect(mapCount).toBe(effectCount);
  });

  it('every ToolCategory value has an entry in CATEGORY_ESCALATION', () => {
    const categoryValues = Object.values(ToolCategory);
    const mapKeys = Object.keys(CATEGORY_ESCALATION);

    for (const category of categoryValues) {
      expect(mapKeys, `CATEGORY_ESCALATION missing entry for '${category}'`).toContain(category);
    }
  });

  it('every CATEGORY_ESCALATION key is a valid ToolCategory value', () => {
    const categoryValues = new Set(Object.values(ToolCategory));
    const mapKeys = Object.keys(CATEGORY_ESCALATION);

    for (const key of mapKeys) {
      expect(categoryValues.has(key as ToolCategory), `Stale CATEGORY_ESCALATION entry '${key}'`).toBe(true);
    }
  });

  it('CATEGORY_ESCALATION has exact same size as ToolCategory', () => {
    const categoryCount = Object.values(ToolCategory).length;
    const mapCount = Object.keys(CATEGORY_ESCALATION).length;
    expect(mapCount).toBe(categoryCount);
  });

  it('all EFFECT_TIER_MAP values are valid RiskTier (0-4)', () => {
    for (const [effect, tier] of Object.entries(EFFECT_TIER_MAP)) {
      expect(tier, `EFFECT_TIER_MAP['${effect}'] = ${tier} is not a valid RiskTier`).toBeGreaterThanOrEqual(0);
      expect(tier).toBeLessThanOrEqual(4);
      expect(Number.isInteger(tier)).toBe(true);
    }
  });

  it('all CATEGORY_ESCALATION values are valid RiskTier (0-4)', () => {
    for (const [category, tier] of Object.entries(CATEGORY_ESCALATION)) {
      expect(tier, `CATEGORY_ESCALATION['${category}'] = ${tier} is not a valid RiskTier`).toBeGreaterThanOrEqual(0);
      expect(tier).toBeLessThanOrEqual(4);
      expect(Number.isInteger(tier)).toBe(true);
    }
  });
});

describe('risk/classifier.classifyToolRequest', () => {
  it('l. produces RiskAssessment with frozen output', () => {
    const req = makeToolRequest({
      id: 'req-risk-1',
      category: ToolCategory.DEPLOY,
      effects: Object.freeze(['WRITE' as EffectType]),
      riskTier: 1,
    });

    const assessment = classifyToolRequest(
      req,
      ORIGINS.CLI,
      { id: 'user-1', type: SUBJECT_TYPES.USER },
    );

    expect(assessment.tier).toBe(3);
    expect(assessment.effects).toEqual(['WRITE']);
    expect(assessment.origin).toBe(ORIGINS.CLI);
    expect(assessment.subject).toEqual({ id: 'user-1', type: SUBJECT_TYPES.USER });
    expect(Object.isFrozen(assessment)).toBe(true);
    expect(Object.isFrozen(assessment.effects)).toBe(true);
    expect(Object.isFrozen(assessment.subject)).toBe(true);
  });
});
