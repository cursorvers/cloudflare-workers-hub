/**
 * GameDay Scenarios — Budget exhaustion category.
 */

import type { GameDayScenario } from '../types';

/** Gradual budget increase triggers DEGRADED then STOPPED */
export const budgetGradualExhaustion: GameDayScenario = Object.freeze({
  id: 'GD-BUDGET-001',
  name: 'Gradual budget exhaustion',
  category: 'BUDGET',
  severity: 'CRITICAL',
  description: 'Budget increases gradually past WARNING then CRITICAL thresholds',
  precondition: Object.freeze({
    mode: 'NORMAL',
    budgetSpent: 0,
    budgetLimit: 100,
  }),
  steps: Object.freeze([
    Object.freeze({ t: 1000, inject: Object.freeze({ type: 'BUDGET_SPEND' as const, value: 50 }) }),
    Object.freeze({ t: 2000, inject: Object.freeze({ type: 'BUDGET_SPEND' as const, value: 40 }), description: 'Approaching WARNING' }),
    Object.freeze({ t: 3000, inject: Object.freeze({ type: 'BUDGET_SPEND' as const, value: 6 }), description: 'Past WARNING (96%)' }),
    Object.freeze({ t: 4000, inject: Object.freeze({ type: 'BUDGET_SPEND' as const, value: 3 }), description: 'Past CRITICAL (99%)' }),
  ]),
  expected: Object.freeze({
    finalMode: 'STOPPED',
    invariants: Object.freeze(['FAIL_CLOSED' as const, 'SAFE_TRANSITION' as const, 'NO_BUDGET_OVERSPEND' as const]),
    shouldStop: true,
  }),
});

/** Budget stays within normal range — system remains NORMAL */
export const budgetNormalOperation: GameDayScenario = Object.freeze({
  id: 'GD-BUDGET-002',
  name: 'Budget normal operation',
  category: 'BUDGET',
  severity: 'MINOR',
  description: 'Budget usage stays well below thresholds',
  precondition: Object.freeze({
    mode: 'NORMAL',
    budgetSpent: 0,
    budgetLimit: 100,
  }),
  steps: Object.freeze([
    Object.freeze({ t: 1000, inject: Object.freeze({ type: 'BUDGET_SPEND' as const, value: 10 }) }),
    Object.freeze({ t: 2000, inject: Object.freeze({ type: 'BUDGET_SPEND' as const, value: 10 }) }),
    Object.freeze({ t: 3000, inject: Object.freeze({ type: 'BUDGET_SPEND' as const, value: 10 }) }),
  ]),
  expected: Object.freeze({
    finalMode: 'NORMAL',
    invariants: Object.freeze(['STATE_FROZEN' as const, 'SAFE_TRANSITION' as const, 'AUDIT_INTEGRITY' as const]),
    shouldStop: false,
  }),
});

export const BUDGET_SCENARIOS: readonly GameDayScenario[] = Object.freeze([
  budgetGradualExhaustion,
  budgetNormalOperation,
]);
