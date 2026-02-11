import { BUDGET_STATES } from '../types';
import { UX_ACTIONS, type UxAction, type UxResolutionInput, type UxResponse } from './types';

function createResponse(
  input: UxResolutionInput,
  action: UxAction,
  reason: string,
  alternatives: readonly string[] = Object.freeze([]),
): UxResponse {
  const frozenAlternatives = Object.freeze([...alternatives]);
  return Object.freeze({
    action,
    reason,
    alternatives: frozenAlternatives,
    requiresUserInput: action === UX_ACTIONS.CONFIRM_CARD || action === UX_ACTIONS.HUMAN_APPROVAL,
    riskTier: input.riskTier,
  });
}

export function resolveUxAction(input: UxResolutionInput): UxResponse {
  if (input.safetyState.circuitBreakerOpen) {
    return createResponse(input, UX_ACTIONS.BLOCKED, 'circuit breaker is open');
  }
  if (input.safetyState.idleTimeoutExceeded) {
    return createResponse(input, UX_ACTIONS.BLOCKED, 'idle timeout exceeded');
  }
  if (input.budgetState === BUDGET_STATES.HALTED) {
    return createResponse(input, UX_ACTIONS.BLOCKED, 'budget halted');
  }
  if (!input.policyDecision.allowed) {
    return createResponse(
      input,
      UX_ACTIONS.BLOCKED,
      input.policyDecision.reason,
      input.policyDecision.alternatives ?? Object.freeze([]),
    );
  }
  if (input.budgetState === BUDGET_STATES.DEGRADED) {
    if (input.riskTier === 0) return createResponse(input, UX_ACTIONS.AUTO_EXECUTE, 'tier 0 allowed');
    return createResponse(input, UX_ACTIONS.BLOCKED, 'read-only in degraded budget');
  }
  if (input.riskTier <= 1) return createResponse(input, UX_ACTIONS.AUTO_EXECUTE, `tier ${input.riskTier} allowed`);
  if (input.riskTier === 2) return createResponse(input, UX_ACTIONS.CONFIRM_CARD, 'tier 2 requires confirmation');
  if (input.riskTier === 3) return createResponse(input, UX_ACTIONS.HUMAN_APPROVAL, 'tier 3 requires approval');
  return createResponse(input, UX_ACTIONS.BLOCKED, 'tier 4 requires explicit user authorization');
}
