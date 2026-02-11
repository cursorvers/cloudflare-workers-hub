import { describe, expect, it } from 'vitest';

import { BUDGET_STATES, type RiskTier } from '../../types';
import type { PolicyDecision } from '../../policy/types';
import type { SafetyState } from '../../safety/safety-controller';
import { resolveUxAction } from '../resolver';
import { UX_ACTIONS, type UxResolutionInput } from '../types';

function makeSafetyState(overrides: Partial<SafetyState> = {}): SafetyState {
  const base: SafetyState = {
    consecutiveFailures: 0,
    circuitBreakerOpen: false,
    lastFailureAt: null,
    recentErrors: Object.freeze([]),
    idleTimeoutExceeded: false,
  };
  return Object.freeze({ ...base, ...overrides });
}

function makePolicyDecision(overrides: Partial<PolicyDecision> = {}): PolicyDecision {
  const base: PolicyDecision = {
    allowed: true,
    reason: 'allowed',
    traceId: 'trace-1',
    timestamp: '2026-02-11T00:00:00.000Z',
  };
  return Object.freeze({ ...base, ...overrides });
}

function makeInput(overrides: Partial<UxResolutionInput> = {}): UxResolutionInput {
  const base: UxResolutionInput = {
    riskTier: 0,
    budgetState: BUDGET_STATES.NORMAL,
    safetyState: makeSafetyState(),
    policyDecision: makePolicyDecision(),
  };
  return Object.freeze({ ...base, ...overrides });
}

function run(
  riskTier: RiskTier,
  overrides: Partial<UxResolutionInput> = {},
) {
  return resolveUxAction(makeInput({ riskTier, ...overrides }));
}

describe('ux/resolver.resolveUxAction', () => {
  it('a. Tier 0 + NORMAL budget + clean safety -> auto-execute', () => {
    expect(run(0).action).toBe(UX_ACTIONS.AUTO_EXECUTE);
  });

  it('b. Tier 1 + NORMAL -> auto-execute', () => {
    expect(run(1).action).toBe(UX_ACTIONS.AUTO_EXECUTE);
  });

  it('c. Tier 2 + NORMAL -> confirm-card (requiresUserInput=true)', () => {
    const result = run(2);
    expect(result.action).toBe(UX_ACTIONS.CONFIRM_CARD);
    expect(result.requiresUserInput).toBe(true);
  });

  it('d. Tier 3 + NORMAL -> human-approval (requiresUserInput=true)', () => {
    const result = run(3);
    expect(result.action).toBe(UX_ACTIONS.HUMAN_APPROVAL);
    expect(result.requiresUserInput).toBe(true);
  });

  it('e. Tier 4 + NORMAL -> blocked', () => {
    expect(run(4).action).toBe(UX_ACTIONS.BLOCKED);
  });

  it('f. Circuit breaker open -> blocked (regardless of tier)', () => {
    const result = run(0, { safetyState: makeSafetyState({ circuitBreakerOpen: true }) });
    expect(result.action).toBe(UX_ACTIONS.BLOCKED);
    expect(result.reason).toBe('circuit breaker is open');
  });

  it('g. Idle timeout exceeded -> blocked', () => {
    const result = run(0, { safetyState: makeSafetyState({ idleTimeoutExceeded: true }) });
    expect(result.action).toBe(UX_ACTIONS.BLOCKED);
    expect(result.reason).toBe('idle timeout exceeded');
  });

  it('h. Budget HALTED -> blocked (regardless of tier)', () => {
    const result = run(0, { budgetState: BUDGET_STATES.HALTED });
    expect(result.action).toBe(UX_ACTIONS.BLOCKED);
    expect(result.reason).toBe('budget halted');
  });

  it('i. Budget DEGRADED + Tier 0 -> auto-execute', () => {
    expect(run(0, { budgetState: BUDGET_STATES.DEGRADED }).action).toBe(UX_ACTIONS.AUTO_EXECUTE);
  });

  it('j. Budget DEGRADED + Tier 1 -> blocked (read-only)', () => {
    const result = run(1, { budgetState: BUDGET_STATES.DEGRADED });
    expect(result.action).toBe(UX_ACTIONS.BLOCKED);
    expect(result.reason).toBe('read-only in degraded budget');
  });

  it('k. Policy denied -> blocked with policy reason and alternatives', () => {
    const result = run(1, {
      policyDecision: makePolicyDecision({
        allowed: false,
        reason: 'capability required',
        alternatives: ['request a bounded capability'],
      }),
    });
    expect(result.action).toBe(UX_ACTIONS.BLOCKED);
    expect(result.reason).toBe('capability required');
    expect(result.alternatives).toEqual(['request a bounded capability']);
  });

  it('l. Evaluation order: circuit breaker takes priority over budget HALTED', () => {
    const result = run(1, {
      safetyState: makeSafetyState({ circuitBreakerOpen: true }),
      budgetState: BUDGET_STATES.HALTED,
    });
    expect(result.action).toBe(UX_ACTIONS.BLOCKED);
    expect(result.reason).toBe('circuit breaker is open');
  });

  it('m. All results are frozen', () => {
    const result = run(2);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.alternatives)).toBe(true);
  });
});
