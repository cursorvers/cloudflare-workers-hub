/**
 * Capability management for the deterministic Policy Engine.
 *
 * Capabilities are immutable tokens granting bounded authorization.
 * - TTL via expiresAt
 * - Scope via subjectId, origin(s), effects, maxTier
 * - Usage cap via maxUses / usedCount
 */

import type { EffectType, Origin, RiskTier } from '../types';
import type { Capability } from './types';

export interface CreateCapabilityParams {
  readonly id: string;
  readonly subjectId: string;
  readonly effects: readonly EffectType[];
  readonly maxTier: RiskTier;
  readonly origins: readonly Origin[];
  readonly expiresAt: string;
  readonly maxUses: number;
}

function freezeArray<T>(values: readonly T[]): readonly T[] {
  return Object.freeze([...values]);
}

/**
 * Create a frozen Capability (usedCount starts at 0).
 */
export function createCapability(params: CreateCapabilityParams): Capability {
  const cap: Capability = {
    id: params.id,
    subjectId: params.subjectId,
    effects: freezeArray(params.effects),
    maxTier: params.maxTier,
    origins: freezeArray(params.origins),
    expiresAt: params.expiresAt,
    maxUses: params.maxUses,
    usedCount: 0,
  };
  return Object.freeze(cap);
}

/**
 * Check capability TTL and usage counter validity.
 */
export function isCapabilityValid(cap: Capability, nowMs: number = Date.now()): boolean {
  if (cap.maxUses < 1) return false;
  if (cap.usedCount < 0) return false;
  if (cap.usedCount >= cap.maxUses) return false;

  const expMs = Date.parse(cap.expiresAt);
  if (!Number.isFinite(expMs)) return false;
  if (expMs <= nowMs) return false;
  return true;
}

/**
 * Consume a capability immutably by returning a new frozen object.
 */
export function consumeCapability(cap: Capability): Capability {
  const next: Capability = {
    ...cap,
    usedCount: cap.usedCount + 1,
  };
  return Object.freeze(next);
}

