/**
 * Risk and governance related types for FUGUE Autopilot.
 * Effect-based tier classification for deterministic policy evaluation.
 */

export type RiskTier = 0 | 1 | 2 | 3 | 4;

export const EFFECT_TYPES = Object.freeze({
  WRITE: 'WRITE',
  PRIV_CHANGE: 'PRIV_CHANGE',
  SECRET_READ: 'SECRET_READ',
  EXFIL: 'EXFIL',
  EXEC: 'EXEC',
} as const);

export type EffectType = (typeof EFFECT_TYPES)[keyof typeof EFFECT_TYPES];

export const ORIGINS = Object.freeze({
  CLI: 'CLI',
  WEBHOOK: 'WEBHOOK',
  GITHUB_ISSUE: 'GITHUB_ISSUE',
  GITHUB_PR: 'GITHUB_PR',
  INTERNAL: 'INTERNAL',
} as const);

export type Origin = (typeof ORIGINS)[keyof typeof ORIGINS];

export const SUBJECT_TYPES = Object.freeze({
  USER: 'USER',
  SYSTEM: 'SYSTEM',
  EXTERNAL: 'EXTERNAL',
} as const);

export type SubjectType = (typeof SUBJECT_TYPES)[keyof typeof SUBJECT_TYPES];

export interface Subject {
  readonly id: string;
  readonly type: SubjectType;
}

export interface RiskAssessment {
  readonly tier: RiskTier;
  readonly effects: readonly EffectType[];
  readonly origin: Origin;
  readonly subject: Subject;
}
