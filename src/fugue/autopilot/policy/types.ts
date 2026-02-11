/**
 * Policy Engine types for FUGUE Autopilot v1.1.
 *
 * Deterministic, deny-by-default, in-process policy evaluation.
 */

import type {
  BudgetState,
  EffectType,
  Origin,
  RiskTier,
  Subject,
  SubjectType,
  TraceContext,
  TrustZone,
} from '../types';

/**
 * Deterministic policy evaluation output.
 *
 * Notes:
 * - `allowed` is false unless explicitly permitted.
 * - `reason` is for audit/debug, not for security decisions.
 */
export type PolicyDecision = {
  allowed: boolean;
  reason: string;
  traceId: string;
  timestamp: string;
  alternatives?: string[];
};

export interface PolicyContext {
  readonly subject: Subject;
  readonly origin: Origin;
  readonly effects: readonly EffectType[];
  readonly riskTier: RiskTier;
  readonly trustZone: TrustZone;
  readonly budgetState: BudgetState;
  readonly traceContext: TraceContext;
}

export interface PolicyRule {
  readonly id: string;
  readonly description: string;
  readonly effects: readonly EffectType[];
  readonly maxTier: RiskTier;
  readonly origins: readonly Origin[];
  readonly subjectTypes: readonly SubjectType[];
  readonly condition?: (ctx: PolicyContext) => boolean;
}

export interface Capability {
  readonly id: string;
  readonly subjectId: string;
  readonly effects: readonly EffectType[];
  readonly maxTier: RiskTier;
  readonly origins: readonly Origin[];
  readonly expiresAt: string;
  readonly maxUses: number;
  readonly usedCount: number;
}
