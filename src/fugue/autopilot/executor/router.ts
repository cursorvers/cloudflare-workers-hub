/**
 * Specialist Router — Routes tool requests to the optimal specialist.
 *
 * Pure function. No side effects. Returns frozen results.
 *
 * Routing priority:
 *   1. Mode gate (STOPPED → reject all)
 *   2. Trust + risk tier filter
 *   3. Circuit breaker check (skip OPEN)
 *   4. Weekly rate limit check
 *   5. Category bonus + cost priority ranking
 */

import type { SpecialistRegistry, SpecialistTrustLevel } from '../specialist/types';
import type { CircuitBreakerState } from '../runtime/circuit-breaker';
import type { ExtendedMode } from '../runtime/coordinator';
import type { ToolRequest } from './types';
import { ToolCategory } from './types';

// =============================================================================
// Types
// =============================================================================

export type RoutingStatus = 'routed' | 'no-match' | 'mode-blocked' | 'all-open';

export interface RoutingResult {
  readonly specialistId: string;
  readonly status: RoutingStatus;
  readonly reason: string;
  readonly alternatives?: readonly string[];
}

// =============================================================================
// Constants
// =============================================================================

/** Cost-optimal ordering: GLM (fixed $15) > Codex (fixed $200) > Gemini (per-token) */
const COST_PRIORITY: Readonly<Record<string, number>> = Object.freeze({
  glm: 0,
  codex: 1,
  gemini: 2,
});

/** Weekly call limits per specialist (from Issue #11 + math-reasoning model) */
const WEEKLY_LIMIT: Readonly<Record<string, number>> = Object.freeze({
  codex: 150,
  glm: 150,
  gemini: 15,
});

/** Category-specialist affinity bonus (higher = better fit) */
const CATEGORY_BONUS: Readonly<Record<ToolCategory, Readonly<Record<string, number>>>> = Object.freeze({
  FILE_READ: Object.freeze({ glm: 2, codex: 1, gemini: 1 }),
  FILE_WRITE: Object.freeze({ glm: 1, codex: 2, gemini: 1 }),
  GIT: Object.freeze({ glm: 1, codex: 2, gemini: 1 }),
  DEPLOY: Object.freeze({ glm: 0, codex: 2, gemini: 1 }),
  AUTH: Object.freeze({ glm: 0, codex: 2, gemini: 1 }),
  SHELL: Object.freeze({ glm: 1, codex: 2, gemini: 0 }),
  NETWORK: Object.freeze({ glm: 2, codex: 1, gemini: 1 }),
});

// =============================================================================
// Helpers
// =============================================================================

function freezeResult(result: RoutingResult): RoutingResult {
  return Object.freeze({
    ...result,
    alternatives: result.alternatives
      ? Object.freeze([...result.alternatives])
      : undefined,
  });
}

/** DEGRADED/RECOVERY → TRUSTED only. NORMAL → all. STOPPED → none. */
function allowsTrust(mode: ExtendedMode, trustLevel: SpecialistTrustLevel): boolean {
  if (mode === 'NORMAL') return true;
  if (mode === 'DEGRADED' || mode === 'RECOVERY') return trustLevel === 'TRUSTED';
  return false; // STOPPED
}

function priorityOf(id: string): number {
  return COST_PRIORITY[id] ?? Number.MAX_SAFE_INTEGER;
}

function limitOf(id: string): number {
  return WEEKLY_LIMIT[id] ?? Number.MAX_SAFE_INTEGER;
}

// =============================================================================
// Router (pure function)
// =============================================================================

export function routeSpecialist(
  request: ToolRequest,
  mode: ExtendedMode,
  circuitStates: ReadonlyMap<string, CircuitBreakerState>,
  weeklyCount: ReadonlyMap<string, number>,
  registry: SpecialistRegistry,
): RoutingResult {
  // 1. Mode gate
  if (mode === 'STOPPED') {
    return freezeResult({
      specialistId: '',
      status: 'mode-blocked',
      reason: 'mode STOPPED blocks all routing',
    });
  }

  // 2. Trust + risk tier filter
  const eligible = registry.specialists.filter(
    (s) => s.enabled && allowsTrust(mode, s.trustLevel) && s.maxRiskTier >= request.riskTier,
  );

  if (eligible.length === 0) {
    const status: RoutingStatus = mode === 'NORMAL' ? 'no-match' : 'mode-blocked';
    return freezeResult({
      specialistId: '',
      status,
      reason: status === 'mode-blocked'
        ? `mode ${mode} requires TRUSTED specialist`
        : 'no specialist matched risk tier constraints',
    });
  }

  // 3. Circuit breaker filter (skip OPEN)
  const notOpen = eligible.filter(
    (s) => (circuitStates.get(s.id)?.state ?? 'CLOSED') !== 'OPEN',
  );

  if (notOpen.length === 0) {
    return freezeResult({
      specialistId: '',
      status: 'all-open',
      reason: 'all matching specialists have circuit breaker OPEN',
      alternatives: eligible.map((s) => s.id),
    });
  }

  // 4. Weekly rate limit filter
  const rateAllowed = notOpen.filter(
    (s) => (weeklyCount.get(s.id) ?? 0) < limitOf(s.id),
  );

  if (rateAllowed.length === 0) {
    return freezeResult({
      specialistId: '',
      status: 'no-match',
      reason: 'all matching specialists exceeded weekly rate limit',
      alternatives: notOpen.map((s) => s.id),
    });
  }

  // 5. Rank by category bonus, then cost priority
  const bonus = CATEGORY_BONUS[request.category];
  const ranked = [...rateAllowed].sort((a, b) => {
    const deltaBonus = (bonus[b.id] ?? 0) - (bonus[a.id] ?? 0);
    if (deltaBonus !== 0) return deltaBonus;
    return priorityOf(a.id) - priorityOf(b.id);
  });

  const winner = ranked[0];
  return freezeResult({
    specialistId: winner.id,
    status: 'routed',
    reason: `routed by category=${request.category} riskTier=${request.riskTier}`,
    alternatives: ranked.slice(1).map((s) => s.id),
  });
}
