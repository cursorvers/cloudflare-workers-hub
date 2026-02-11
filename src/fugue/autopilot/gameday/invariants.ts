/**
 * GameDay Invariants — Safety property verification.
 *
 * Evaluates that safety invariants hold after scenario execution.
 * All functions are pure and return frozen objects.
 */

import type { InvariantId, InvariantResult, StepResult } from './types';

// =============================================================================
// Invariant Evaluators
// =============================================================================

function checkFailClosed(
  steps: readonly StepResult[],
  finalMode: string,
): InvariantResult {
  // Any step with ERROR outcome should result in STOPPED
  const hasError = steps.some(s => s.outcome === 'ERROR');
  const isStopped = finalMode === 'STOPPED';

  if (hasError && !isStopped) {
    return Object.freeze({
      invariantId: 'FAIL_CLOSED' as InvariantId,
      passed: false,
      reason: `Error detected but final mode is ${finalMode}, expected STOPPED`,
    });
  }

  // Any step with STOP verdict should transition to STOPPED
  const hasStopVerdict = steps.some(s => s.stateAfter.guardVerdict === 'STOP');
  if (hasStopVerdict && finalMode !== 'STOPPED') {
    return Object.freeze({
      invariantId: 'FAIL_CLOSED' as InvariantId,
      passed: false,
      reason: `STOP verdict issued but final mode is ${finalMode}`,
    });
  }

  return Object.freeze({
    invariantId: 'FAIL_CLOSED' as InvariantId,
    passed: true,
    reason: 'Fail-closed invariant holds',
  });
}

function checkStateFrozen(steps: readonly StepResult[]): InvariantResult {
  // Verify all step results have stateAfter (structural check)
  const allHaveState = steps.every(s => s.stateAfter != null && typeof s.stateAfter.mode === 'string');

  return Object.freeze({
    invariantId: 'STATE_FROZEN' as InvariantId,
    passed: allHaveState,
    reason: allHaveState
      ? 'All step states are structurally valid'
      : 'Some step states are missing or malformed',
  });
}

function checkSafeTransition(
  steps: readonly StepResult[],
  preconditionMode?: string,
): InvariantResult {
  // Valid transitions: any mode can go to STOPPED, STOPPED can go to RECOVERY/NORMAL
  const VALID_TARGETS: Record<string, readonly string[]> = {
    STOPPED: ['RECOVERY', 'NORMAL', 'STOPPED'],
    RECOVERY: ['NORMAL', 'STOPPED', 'RECOVERY'],
    NORMAL: ['DEGRADED', 'STOPPED', 'NORMAL'],
    DEGRADED: ['NORMAL', 'STOPPED', 'DEGRADED'],
  };

  const violations: string[] = [];

  // Validate transition from precondition to first step
  if (steps.length > 0 && preconditionMode != null) {
    const firstMode = steps[0].stateAfter.mode;
    if (firstMode !== preconditionMode) {
      const allowed = VALID_TARGETS[preconditionMode] ?? ['STOPPED'];
      if (!allowed.includes(firstMode)) {
        violations.push(`Precondition: ${preconditionMode} → ${firstMode}`);
      }
    }
  }

  // Validate step-to-step transitions
  for (let i = 1; i < steps.length; i++) {
    const prevMode = steps[i - 1].stateAfter.mode;
    const currentMode = steps[i].stateAfter.mode;
    if (currentMode !== prevMode) {
      const allowed = VALID_TARGETS[prevMode] ?? ['STOPPED'];
      if (!allowed.includes(currentMode)) {
        violations.push(`Step ${i}: ${prevMode} → ${currentMode}`);
      }
    }
  }

  return Object.freeze({
    invariantId: 'SAFE_TRANSITION' as InvariantId,
    passed: violations.length === 0,
    reason: violations.length === 0
      ? 'All mode transitions are valid'
      : `Invalid transitions: ${violations.join(', ')}`,
  });
}

function checkNoBudgetOverspend(
  steps: readonly StepResult[],
  budgetLimit?: number,
): InvariantResult {
  if (budgetLimit == null || budgetLimit <= 0) {
    return Object.freeze({
      invariantId: 'NO_BUDGET_OVERSPEND' as InvariantId,
      passed: true,
      reason: 'No budget limit defined, skip check',
    });
  }

  const overspend = steps.find(
    s => s.stateAfter.budgetSpent != null && s.stateAfter.budgetSpent > budgetLimit,
  );

  if (overspend) {
    return Object.freeze({
      invariantId: 'NO_BUDGET_OVERSPEND' as InvariantId,
      passed: false,
      reason: `Step ${overspend.stepIndex}: spent ${overspend.stateAfter.budgetSpent} > limit ${budgetLimit}`,
    });
  }

  return Object.freeze({
    invariantId: 'NO_BUDGET_OVERSPEND' as InvariantId,
    passed: true,
    reason: `All steps within budget limit ${budgetLimit}`,
  });
}

function checkAuditIntegrity(steps: readonly StepResult[]): InvariantResult {
  // Basic structural check: all steps have sequential indices
  const sequential = steps.every((s, i) => s.stepIndex === i);

  return Object.freeze({
    invariantId: 'AUDIT_INTEGRITY' as InvariantId,
    passed: sequential,
    reason: sequential
      ? 'Step indices are sequential and complete'
      : 'Step indices are not sequential',
  });
}

// =============================================================================
// Main Evaluator
// =============================================================================

interface EvaluatorContext {
  readonly steps: readonly StepResult[];
  readonly finalMode: string;
  readonly budgetLimit?: number;
  readonly preconditionMode?: string;
}

const EVALUATORS: Record<InvariantId, (ctx: EvaluatorContext) => InvariantResult> = {
  FAIL_CLOSED: (ctx) => checkFailClosed(ctx.steps, ctx.finalMode),
  STATE_FROZEN: (ctx) => checkStateFrozen(ctx.steps),
  SAFE_TRANSITION: (ctx) => checkSafeTransition(ctx.steps, ctx.preconditionMode),
  NO_BUDGET_OVERSPEND: (ctx) => checkNoBudgetOverspend(ctx.steps, ctx.budgetLimit),
  AUDIT_INTEGRITY: (ctx) => checkAuditIntegrity(ctx.steps),
};

/**
 * Evaluate a set of invariants against step results.
 * Returns frozen array of InvariantResult.
 */
export function evaluateInvariants(
  invariantIds: readonly InvariantId[],
  steps: readonly StepResult[],
  finalMode: string,
  budgetLimit?: number,
  preconditionMode?: string,
): readonly InvariantResult[] {
  const ctx: EvaluatorContext = { steps, finalMode, budgetLimit, preconditionMode };
  const results = invariantIds.map(id => {
    const evaluator = EVALUATORS[id];
    if (!evaluator) {
      return Object.freeze({
        invariantId: id,
        passed: false,
        reason: `Unknown invariant: ${id}`,
      });
    }
    return evaluator(ctx);
  });

  return Object.freeze(results);
}
