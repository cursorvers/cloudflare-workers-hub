/**
 * GameDay Scenarios — Circuit breaker category.
 */

import type { GameDayScenario } from '../types';

/** Error burst opens circuit breaker → STOPPED */
export const cbErrorBurst: GameDayScenario = Object.freeze({
  id: 'GD-CB-001',
  name: 'Circuit breaker opens on error burst',
  category: 'CIRCUIT_BREAKER',
  severity: 'CRITICAL',
  description: 'Consecutive failures open circuit breaker, triggering auto-stop',
  precondition: Object.freeze({
    mode: 'NORMAL',
    budgetSpent: 0,
    budgetLimit: 200,
  }),
  steps: Object.freeze([
    Object.freeze({ t: 1000, inject: Object.freeze({ type: 'CB_FAILURE_BURST' as const, value: 5 }), description: '5 consecutive failures → OPEN' }),
  ]),
  expected: Object.freeze({
    finalMode: 'STOPPED',
    invariants: Object.freeze(['FAIL_CLOSED' as const, 'SAFE_TRANSITION' as const, 'STATE_FROZEN' as const]),
    shouldStop: true,
  }),
});

/** Low error count keeps circuit breaker closed → NORMAL */
export const cbNormalOperation: GameDayScenario = Object.freeze({
  id: 'GD-CB-002',
  name: 'Circuit breaker stays closed under normal load',
  category: 'CIRCUIT_BREAKER',
  severity: 'MINOR',
  description: 'Few errors do not trip circuit breaker',
  precondition: Object.freeze({
    mode: 'NORMAL',
    budgetSpent: 0,
    budgetLimit: 200,
  }),
  steps: Object.freeze([
    Object.freeze({ t: 1000, inject: Object.freeze({ type: 'CB_FAILURE_BURST' as const, value: 2 }), description: '2 failures, below threshold' }),
  ]),
  expected: Object.freeze({
    finalMode: 'NORMAL',
    invariants: Object.freeze(['STATE_FROZEN' as const, 'SAFE_TRANSITION' as const, 'AUDIT_INTEGRITY' as const]),
    shouldStop: false,
  }),
});

export const CIRCUIT_BREAKER_SCENARIOS: readonly GameDayScenario[] = Object.freeze([
  cbErrorBurst,
  cbNormalOperation,
]);
