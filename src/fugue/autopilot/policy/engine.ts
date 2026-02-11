/**
 * Deterministic Policy Engine (in-process library).
 *
 * Design goals:
 * - deny-by-default
 * - deterministic (no LLM)
 * - always return a Deny decision on error
 */

import { BUDGET_STATES, EFFECT_TYPES, ORIGINS, SUBJECT_TYPES } from '../types';
import type { BudgetState, EffectType, Origin, RiskTier, SubjectType } from '../types';

import { isCapabilityValid } from './capability';
import type { Capability, PolicyContext, PolicyDecision, PolicyRule } from './types';

function nowIso(nowMs: number = Date.now()): string {
  return new Date(nowMs).toISOString();
}

function freezeStrings(values: readonly string[] | undefined): string[] | undefined {
  if (!values) return undefined;
  return Object.freeze([...values]) as unknown as string[];
}

function decision(
  allowed: boolean,
  reason: string,
  traceId: string,
  timestamp: string,
  alternatives?: readonly string[],
): PolicyDecision {
  return Object.freeze({
    allowed,
    reason,
    traceId,
    timestamp,
    alternatives: freezeStrings(alternatives),
  });
}

function deny(ctx: PolicyContext, reason: string, alternatives?: readonly string[]): PolicyDecision {
  return decision(false, reason, String(ctx.traceContext.traceId), nowIso(), alternatives);
}

function allow(ctx: PolicyContext, reason: string): PolicyDecision {
  return decision(true, reason, String(ctx.traceContext.traceId), nowIso());
}

function hasEffect(effects: readonly EffectType[], effect: EffectType): boolean {
  return effects.includes(effect);
}

function isExternalOrigin(origin: Origin): boolean {
  return (
    origin === ORIGINS.WEBHOOK ||
    origin === ORIGINS.GITHUB_ISSUE ||
    origin === ORIGINS.GITHUB_PR
  );
}

function effectsSubset(requested: readonly EffectType[], allowed: readonly EffectType[]): boolean {
  for (const e of requested) {
    if (!allowed.includes(e)) return false;
  }
  return true;
}

function includesOrigin(origins: readonly Origin[], origin: Origin): boolean {
  return origins.includes(origin);
}

function includesSubjectType(subjectTypes: readonly SubjectType[], subjectType: SubjectType): boolean {
  return subjectTypes.includes(subjectType);
}

function findValidCapability(
  ctx: PolicyContext,
  capabilities: readonly Capability[],
  nowMs: number,
): Capability | undefined {
  for (const cap of capabilities) {
    if (!isCapabilityValid(cap, nowMs)) continue;
    if (cap.subjectId !== ctx.subject.id) continue;
    if (ctx.riskTier > cap.maxTier) continue;
    if (!includesOrigin(cap.origins, ctx.origin)) continue;
    if (!effectsSubset(ctx.effects, cap.effects)) continue;
    return cap;
  }
  return undefined;
}

function ruleMatches(ctx: PolicyContext, r: PolicyRule): boolean {
  if (ctx.riskTier > r.maxTier) return false;
  if (!includesOrigin(r.origins, ctx.origin)) return false;
  if (!includesSubjectType(r.subjectTypes, ctx.subject.type)) return false;
  if (!effectsSubset(ctx.effects, r.effects)) return false;
  if (r.condition && !r.condition(ctx)) return false;
  return true;
}

function findMatchingRule(ctx: PolicyContext, rules: readonly PolicyRule[]): PolicyRule | undefined {
  for (const r of rules) {
    if (ruleMatches(ctx, r)) return r;
  }
  return undefined;
}

function capabilityRequired(riskTier: RiskTier): boolean {
  return riskTier >= 3;
}

function gateByBudget(budgetState: BudgetState, effects: readonly EffectType[]): string | undefined {
  if (budgetState === BUDGET_STATES.HALTED) return 'budget halted';
  if (budgetState === BUDGET_STATES.DEGRADED && hasEffect(effects, EFFECT_TYPES.WRITE)) {
    return 'read-only in degraded budget state';
  }
  return undefined;
}

/**
 * Evaluate a request context against policy rules and capabilities.
 *
 * Deny-by-default flow:
 * 1. Budget gates
 * 2. Origin constraints (external origins cannot exceed Tier2)
 * 3. Find a valid capability (if any)
 * 4. Match a policy rule
 * 5. If no rule matches => deny
 * 6. If capability is required but missing => deny
 * 7. Allow
 *
 * On any error, returns deny("internal error").
 */
export function evaluatePolicy(
  ctx: PolicyContext,
  rules: readonly PolicyRule[],
  capabilities: readonly Capability[],
): PolicyDecision {
  try {
    const nowMs = Date.now();

    const budgetBlock = gateByBudget(ctx.budgetState, ctx.effects);
    if (budgetBlock) return deny(ctx, budgetBlock);

    if (isExternalOrigin(ctx.origin) && ctx.riskTier >= 3) {
      return deny(ctx, 'external origin exceeds max tier (maxTier=2)');
    }

    const cap = findValidCapability(ctx, capabilities, nowMs);
    const matchedRule = findMatchingRule(ctx, rules);
    if (!matchedRule) return deny(ctx, 'no matching rule');

    if (capabilityRequired(ctx.riskTier) && !cap) {
      return deny(ctx, 'capability required', ['request a bounded capability']);
    }

    if (ctx.riskTier >= 4 && ctx.subject.type !== SUBJECT_TYPES.USER) {
      return deny(ctx, 'tier4 requires USER subject');
    }

    const via = cap ? `rule=${matchedRule.id}, capability=${cap.id}` : `rule=${matchedRule.id}`;
    return allow(ctx, `allowed (${via})`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    return deny(ctx, `internal error: ${msg}`);
  }
}
