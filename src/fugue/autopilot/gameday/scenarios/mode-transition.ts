/**
 * GameDay Scenarios — Mode transition category.
 */

import type { GameDayScenario } from '../types';

/** Full lifecycle: NORMAL → DEGRADED → STOPPED via multi-fault */
export const modeFullLifecycle: GameDayScenario = Object.freeze({
  id: 'GD-MODE-001',
  name: 'Full mode lifecycle under escalating faults',
  category: 'MODE_TRANSITION',
  severity: 'MAJOR',
  description: 'Budget warning degrades, then circuit breaker opens and stops',
  precondition: Object.freeze({
    mode: 'NORMAL',
    budgetSpent: 0,
    budgetLimit: 100,
  }),
  steps: Object.freeze([
    Object.freeze({ t: 1000, inject: Object.freeze({ type: 'BUDGET_SPEND' as const, value: 96 }), description: 'Budget at 96% → WARNING → DEGRADED' }),
    Object.freeze({ t: 2000, inject: Object.freeze({ type: 'CB_FAILURE_BURST' as const, value: 5 }), description: 'CB opens → STOP' }),
  ]),
  expected: Object.freeze({
    finalMode: 'STOPPED',
    invariants: Object.freeze(['FAIL_CLOSED' as const, 'SAFE_TRANSITION' as const, 'STATE_FROZEN' as const, 'AUDIT_INTEGRITY' as const]),
    shouldStop: true,
    shouldDegrade: true,
  }),
});

/** Forced mode transition via inject */
export const modeForcedRecovery: GameDayScenario = Object.freeze({
  id: 'GD-MODE-002',
  name: 'Forced mode transitions (recovery path)',
  category: 'MODE_TRANSITION',
  severity: 'MAJOR',
  description: 'Manual mode injection tests STOPPED → RECOVERY → NORMAL path',
  precondition: Object.freeze({
    mode: 'STOPPED',
    budgetSpent: 0,
    budgetLimit: 200,
  }),
  steps: Object.freeze([
    Object.freeze({
      t: 1000,
      inject: Object.freeze({
        type: 'MODE_FORCE' as const,
        value: 0,
        metadata: Object.freeze({ mode: 'RECOVERY' }),
      }),
      description: 'Force RECOVERY mode',
    }),
    Object.freeze({
      t: 2000,
      inject: Object.freeze({
        type: 'MODE_FORCE' as const,
        value: 0,
        metadata: Object.freeze({ mode: 'NORMAL' }),
      }),
      description: 'Force NORMAL mode (recovery complete)',
    }),
  ]),
  expected: Object.freeze({
    finalMode: 'NORMAL',
    invariants: Object.freeze(['SAFE_TRANSITION' as const, 'STATE_FROZEN' as const, 'AUDIT_INTEGRITY' as const]),
    shouldStop: false,
  }),
});

export const MODE_TRANSITION_SCENARIOS: readonly GameDayScenario[] = Object.freeze([
  modeFullLifecycle,
  modeForcedRecovery,
]);
