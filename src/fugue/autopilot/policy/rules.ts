/**
 * Default deterministic policy rules (delegation matrix baseline).
 *
 * Notes:
 * - This file only encodes coarse allowlists by RiskTier/Origin/EffectType.
 * - Higher tiers are still gated by capabilities in the engine (deny-by-default).
 */

import { EFFECT_TYPES, ORIGINS, SUBJECT_TYPES } from '../types';
import type { PolicyRule } from './types';

function freezeArray<T>(values: readonly T[]): readonly T[] {
  return Object.freeze([...values]);
}

function rule(r: PolicyRule): PolicyRule {
  return Object.freeze({
    ...r,
    effects: freezeArray(r.effects),
    origins: freezeArray(r.origins),
    subjectTypes: freezeArray(r.subjectTypes),
  });
}

const ALL_ORIGINS = freezeArray(Object.values(ORIGINS));
const CLI_INTERNAL = freezeArray([ORIGINS.CLI, ORIGINS.INTERNAL]);
const CLI_ONLY = freezeArray([ORIGINS.CLI]);
const ALL_SUBJECTS = freezeArray(Object.values(SUBJECT_TYPES));

/**
 * Default ruleset for Policy Engine.
 */
export const DEFAULT_RULES: readonly PolicyRule[] = freezeArray([
  // Tier0: read/lint/test style operations (no dangerous effects).
  rule({
    id: 'tier0-readonly',
    description: 'Tier0 readonly operations (no effects) are allowed from any origin.',
    effects: [],
    maxTier: 0,
    origins: ALL_ORIGINS,
    subjectTypes: ALL_SUBJECTS,
  }),

  // Tier1: single file edit (write) restricted to CLI/INTERNAL.
  rule({
    id: 'tier1-write-cli-internal',
    description: 'Tier1 write operations are allowed only from CLI/INTERNAL.',
    effects: [EFFECT_TYPES.WRITE],
    maxTier: 1,
    origins: CLI_INTERNAL,
    subjectTypes: freezeArray([SUBJECT_TYPES.USER, SUBJECT_TYPES.SYSTEM]),
  }),

  // Tier2: multi-file / design work (still write), restricted to CLI/INTERNAL.
  rule({
    id: 'tier2-write-cli-internal',
    description: 'Tier2 write operations are allowed only from CLI/INTERNAL.',
    effects: [EFFECT_TYPES.WRITE],
    maxTier: 2,
    origins: CLI_INTERNAL,
    subjectTypes: freezeArray([SUBJECT_TYPES.USER, SUBJECT_TYPES.SYSTEM]),
  }),

  // Tier3: destructive / deploy / auth class operations (capability-gated in engine), CLI only.
  rule({
    id: 'tier3-sensitive-cli',
    description: 'Tier3 sensitive operations are only considered from CLI (capability required).',
    effects: [
      EFFECT_TYPES.WRITE,
      EFFECT_TYPES.PRIV_CHANGE,
      EFFECT_TYPES.SECRET_READ,
      EFFECT_TYPES.EXFIL,
      EFFECT_TYPES.EXEC,
    ],
    maxTier: 3,
    origins: CLI_ONLY,
    subjectTypes: freezeArray([SUBJECT_TYPES.USER, SUBJECT_TYPES.SYSTEM]),
  }),

  // Tier4: production / irreversible operations (capability + USER required in engine), CLI only.
  rule({
    id: 'tier4-prod-cli-user',
    description: 'Tier4 production/irreversible operations are CLI-only (capability + USER required).',
    effects: [
      EFFECT_TYPES.WRITE,
      EFFECT_TYPES.PRIV_CHANGE,
      EFFECT_TYPES.SECRET_READ,
      EFFECT_TYPES.EXFIL,
      EFFECT_TYPES.EXEC,
    ],
    maxTier: 4,
    origins: CLI_ONLY,
    subjectTypes: freezeArray([SUBJECT_TYPES.USER]),
  }),
]);

