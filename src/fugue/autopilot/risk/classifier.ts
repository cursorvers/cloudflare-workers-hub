import { ToolCategory, type ToolRequest } from '../executor/types';
import {
  EFFECT_TYPES,
  ORIGINS,
  SUBJECT_TYPES,
  type EffectType,
  type Origin,
  type RiskAssessment,
  type RiskTier,
} from '../types';

export interface RiskClassificationInput {
  readonly effects: readonly EffectType[];
  readonly category: ToolCategory;
  readonly origin: Origin;
}

/** Exported for release-gate consistency tests */
export const EFFECT_TIER_MAP = Object.freeze<Record<EffectType, RiskTier>>({
  [EFFECT_TYPES.WRITE]: 1,
  [EFFECT_TYPES.PRIV_CHANGE]: 3,
  [EFFECT_TYPES.SECRET_READ]: 3,
  [EFFECT_TYPES.EXFIL]: 4,
  [EFFECT_TYPES.EXEC]: 3,
});

/** Exported for release-gate consistency tests */
export const CATEGORY_ESCALATION = Object.freeze<Record<ToolCategory, RiskTier>>({
  [ToolCategory.FILE_READ]: 0,
  [ToolCategory.FILE_WRITE]: 0,
  [ToolCategory.GIT]: 1,
  [ToolCategory.DEPLOY]: 3,
  [ToolCategory.AUTH]: 3,
  [ToolCategory.SHELL]: 2,
  [ToolCategory.NETWORK]: 2,
});

const KNOWN_EFFECTS = new Set<EffectType>(Object.values(EFFECT_TYPES));
const KNOWN_CATEGORIES = new Set<ToolCategory>(Object.values(ToolCategory));

function clampTier(value: number): RiskTier {
  if (value <= 0) return 0;
  if (value >= 4) return 4;
  if (value <= 1) return 1;
  if (value <= 2) return 2;
  return 3;
}

export function classifyRisk(input: RiskClassificationInput): RiskTier {
  const { effects, category } = input;

  if (!KNOWN_CATEGORIES.has(category)) return 4;

  let effectTier: RiskTier = 0;
  for (const effect of effects) {
    if (!KNOWN_EFFECTS.has(effect)) return 4;
    const tier = EFFECT_TIER_MAP[effect];
    if (tier > effectTier) effectTier = tier;
  }

  const categoryMin = CATEGORY_ESCALATION[category];
  return clampTier(Math.max(effectTier, categoryMin));
}

/**
 * Classify a ToolRequest into a RiskAssessment.
 * origin and subject MUST be provided by the caller to prevent origin laundering.
 */
export function classifyToolRequest(
  request: ToolRequest,
  origin: Origin,
  subject: { readonly id: string; readonly type: (typeof SUBJECT_TYPES)[keyof typeof SUBJECT_TYPES] },
): RiskAssessment {
  const tier = classifyRisk({
    effects: request.effects,
    category: request.category,
    origin,
  });

  return Object.freeze({
    tier,
    effects: Object.freeze([...request.effects]),
    origin,
    subject: Object.freeze({ ...subject }),
  });
}
