/**
 * GameDay Runner — Executes scenarios against pure runtime functions.
 *
 * No side effects. No DO or storage interaction.
 * All functions are pure and return frozen objects.
 */

import {
  createInitialExtendedState,
  applyExtendedTransition,
  type ExtendedRuntimeState,
  type ExtendedMode,
  EXTENDED_MODES,
} from '../runtime/coordinator';
import { runGuardCheck, type GuardInput } from '../runtime/runtime-guard';
import {
  createCircuitBreakerState,
  recordFailure as cbRecordFailure,
  type CircuitBreakerState,
} from '../runtime/circuit-breaker';
import {
  createHeartbeatState,
  recordHeartbeat,
  type HeartbeatState,
} from '../runtime/heartbeat';
import { evaluateInvariants } from './invariants';
import type {
  GameDayScenario,
  GameDayStep,
  StepResult,
  StepOutcome,
  ScenarioResult,
  ScenarioStatus,
} from './types';

// =============================================================================
// Internal State (mutable during execution, frozen at output)
// =============================================================================

interface RunnerState {
  runtimeState: ExtendedRuntimeState;
  budgetSpent: number;
  budgetLimit: number;
  circuitBreaker: CircuitBreakerState;
  heartbeat: HeartbeatState;
  currentTime: number;
}

// =============================================================================
// Step Execution
// =============================================================================

/**
 * Build initial runtime state for a given precondition mode.
 * Uses valid FSM transition paths since direct construction would
 * bypass safety invariants. Transition paths:
 *   STOPPED  → (already initial)
 *   NORMAL   → STOPPED → NORMAL
 *   DEGRADED → STOPPED → NORMAL → DEGRADED
 *   RECOVERY → STOPPED → RECOVERY
 */
function buildPreconditionState(mode: ExtendedMode, startTime: number): ExtendedRuntimeState {
  let state = createInitialExtendedState(startTime); // STOPPED

  if (mode === 'STOPPED') return state;

  if (mode === 'NORMAL') {
    return applyExtendedTransition(state, 'NORMAL', 'gameday-precondition', startTime);
  }

  if (mode === 'RECOVERY') {
    return applyExtendedTransition(state, 'RECOVERY', 'gameday-precondition', startTime);
  }

  if (mode === 'DEGRADED') {
    // STOPPED → NORMAL → DEGRADED (valid FSM path)
    state = applyExtendedTransition(state, 'NORMAL', 'gameday-precondition', startTime);
    return applyExtendedTransition(state, 'DEGRADED', 'gameday-precondition', startTime);
  }

  // Fail-closed: unknown mode → stay STOPPED
  return state;
}

function initState(scenario: GameDayScenario): RunnerState {
  const startTime = 0;
  const runtimeState = buildPreconditionState(scenario.precondition.mode, startTime);

  return {
    runtimeState,
    budgetSpent: scenario.precondition.budgetSpent ?? 0,
    budgetLimit: scenario.precondition.budgetLimit ?? 200,
    circuitBreaker: createCircuitBreakerState(),
    heartbeat: recordHeartbeat(createHeartbeatState(startTime), startTime),
    currentTime: startTime,
  };
}

function executeStep(state: RunnerState, step: GameDayStep, stepIndex: number): { state: RunnerState; result: StepResult } {
  const t = step.t;
  const newState = { ...state, currentTime: t };

  try {
    switch (step.inject.type) {
      case 'BUDGET_SPEND':
      case 'BUDGET_SPIKE': {
        newState.budgetSpent = Math.min(
          newState.budgetSpent + step.inject.value,
          newState.budgetLimit * 1.1, // cap at 110% for safety
        );
        break;
      }
      case 'ERROR_BURST': {
        // Simulate errors by recording failures on circuit breaker
        const count = Math.floor(step.inject.value);
        let cb = newState.circuitBreaker;
        for (let i = 0; i < count; i++) {
          cb = cbRecordFailure(cb, undefined, t + i);
        }
        newState.circuitBreaker = cb;
        break;
      }
      case 'CB_FAILURE_BURST': {
        const count = Math.floor(step.inject.value);
        let cb = newState.circuitBreaker;
        for (let i = 0; i < count; i++) {
          cb = cbRecordFailure(cb, undefined, t + i);
        }
        newState.circuitBreaker = cb;
        break;
      }
      case 'HEARTBEAT_STOP': {
        // Don't record heartbeat — simulate missed heartbeats by advancing time
        // heartbeat stays at last recorded time
        break;
      }
      case 'HEARTBEAT_LATE': {
        // Record heartbeat but with significant delay
        newState.heartbeat = recordHeartbeat(newState.heartbeat, t);
        break;
      }
      case 'MODE_FORCE': {
        const rawMode = step.inject.metadata?.mode as string ?? 'STOPPED';
        const targetMode: ExtendedMode = EXTENDED_MODES.includes(rawMode as ExtendedMode)
          ? rawMode as ExtendedMode
          : 'STOPPED'; // fail-closed on invalid mode
        newState.runtimeState = applyExtendedTransition(
          newState.runtimeState,
          targetMode,
          `gameday-inject: ${step.inject.type}`,
          t,
        );
        break;
      }
    }

    // Run guard check after injection
    const guardInput: GuardInput = {
      budget: { spent: newState.budgetSpent, limit: newState.budgetLimit },
      circuitBreaker: { state: newState.circuitBreaker },
      heartbeat: { state: newState.heartbeat },
    };
    const guardResult = runGuardCheck(guardInput, t);

    // Apply guard verdict to runtime state
    if (guardResult.shouldTransitionToStopped && newState.runtimeState.mode !== 'STOPPED') {
      newState.runtimeState = applyExtendedTransition(
        newState.runtimeState,
        'STOPPED',
        `gameday-guard: ${guardResult.reasons.join(', ')}`,
        t,
      );
    } else if (guardResult.shouldTransitionToDegraded && newState.runtimeState.mode === 'NORMAL') {
      newState.runtimeState = applyExtendedTransition(
        newState.runtimeState,
        'DEGRADED',
        `gameday-guard: ${guardResult.warnings.join(', ')}`,
        t,
      );
    }

    const stepResult: StepResult = Object.freeze({
      stepIndex,
      t,
      inject: step.inject,
      outcome: 'PASS' as StepOutcome,
      stateAfter: Object.freeze({
        mode: newState.runtimeState.mode,
        budgetSpent: newState.budgetSpent,
        budgetRatio: newState.budgetSpent / newState.budgetLimit,
        circuitBreakerState: newState.circuitBreaker.state,
        heartbeatStatus: undefined,
        throttleLevel: undefined,
        guardVerdict: guardResult.verdict,
      }),
    });

    return { state: newState, result: stepResult };
  } catch (error) {
    // Fail-closed: any error → STOPPED
    newState.runtimeState = applyExtendedTransition(
      newState.runtimeState,
      'STOPPED',
      `gameday-error: ${error instanceof Error ? error.message : 'unknown'}`,
      t,
    );

    const stepResult: StepResult = Object.freeze({
      stepIndex,
      t,
      inject: step.inject,
      outcome: 'ERROR' as StepOutcome,
      stateAfter: Object.freeze({
        mode: 'STOPPED',
        budgetSpent: newState.budgetSpent,
        budgetRatio: newState.budgetSpent / newState.budgetLimit,
        circuitBreakerState: newState.circuitBreaker.state,
      }),
      detail: error instanceof Error ? error.message : 'Unknown error',
    });

    return { state: newState, result: stepResult };
  }
}

// =============================================================================
// Scenario Runner
// =============================================================================

/**
 * Run a single GameDay scenario.
 * Returns frozen ScenarioResult.
 */
export function runScenario(scenario: GameDayScenario): ScenarioResult {
  const startTime = performance.now();
  let state = initState(scenario);
  const stepResults: StepResult[] = [];

  for (let i = 0; i < scenario.steps.length; i++) {
    const { state: nextState, result } = executeStep(state, scenario.steps[i], i);
    state = nextState;
    stepResults.push(result);
  }

  const finalMode = state.runtimeState.mode;
  const lastStep = stepResults[stepResults.length - 1];

  // Evaluate invariants (pass precondition mode for transition validation)
  const invariantResults = evaluateInvariants(
    scenario.expected.invariants,
    stepResults,
    finalMode,
    state.budgetLimit,
    scenario.precondition.mode,
  );

  // Determine overall status
  const allInvariantsPassed = invariantResults.every(r => r.passed);
  const modeMatches = finalMode === scenario.expected.finalMode;
  const hasErrors = stepResults.some(s => s.outcome === 'ERROR');

  let status: ScenarioStatus;
  let failureReason: string | undefined;

  if (hasErrors) {
    status = 'ERROR';
    failureReason = stepResults.find(s => s.outcome === 'ERROR')?.detail ?? 'Unknown error';
  } else if (!modeMatches) {
    status = 'FAIL';
    failureReason = `Expected final mode ${scenario.expected.finalMode}, got ${finalMode}`;
  } else if (!allInvariantsPassed) {
    status = 'FAIL';
    const failed = invariantResults.filter(r => !r.passed);
    failureReason = `Invariant violations: ${failed.map(f => `${f.invariantId}: ${f.reason}`).join('; ')}`;
  } else {
    status = 'PASS';
  }

  const durationMs = performance.now() - startTime;

  return Object.freeze({
    scenarioId: scenario.id,
    scenarioName: scenario.name,
    category: scenario.category,
    severity: scenario.severity,
    status,
    durationMs,
    steps: Object.freeze(stepResults),
    invariants: invariantResults,
    expected: scenario.expected,
    actual: Object.freeze({
      finalMode,
      guardVerdict: lastStep?.stateAfter.guardVerdict,
      throttleLevel: lastStep?.stateAfter.throttleLevel,
    }),
    failureReason,
  });
}

/**
 * Run multiple scenarios.
 * Returns frozen array of ScenarioResult.
 */
export function runAllScenarios(scenarios: readonly GameDayScenario[]): readonly ScenarioResult[] {
  return Object.freeze(scenarios.map(runScenario));
}
