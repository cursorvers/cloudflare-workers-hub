/**
 * GameDay Scenarios — Heartbeat failure category.
 */

import type { GameDayScenario } from '../types';

/** Heartbeat stops → DEAD → STOPPED */
export const heartbeatDead: GameDayScenario = Object.freeze({
  id: 'GD-HB-001',
  name: 'Heartbeat failure triggers auto-stop',
  category: 'HEARTBEAT',
  severity: 'CRITICAL',
  description: 'Heartbeat stops for extended period, triggering DEAD detection and auto-stop',
  precondition: Object.freeze({
    mode: 'NORMAL',
    budgetSpent: 0,
    budgetLimit: 200,
  }),
  steps: Object.freeze([
    Object.freeze({ t: 1000, inject: Object.freeze({ type: 'HEARTBEAT_STOP' as const, value: 1 }), description: 'Stop heartbeat' }),
    Object.freeze({ t: 40000, inject: Object.freeze({ type: 'BUDGET_SPEND' as const, value: 0 }), description: 'Guard check at t=40s (heartbeat dead)' }),
  ]),
  expected: Object.freeze({
    finalMode: 'STOPPED',
    invariants: Object.freeze(['FAIL_CLOSED' as const, 'SAFE_TRANSITION' as const, 'STATE_FROZEN' as const]),
    shouldStop: true,
  }),
});

/** Heartbeat is regular → system stays NORMAL */
export const heartbeatHealthy: GameDayScenario = Object.freeze({
  id: 'GD-HB-002',
  name: 'Healthy heartbeat maintains NORMAL',
  category: 'HEARTBEAT',
  severity: 'MINOR',
  description: 'Regular heartbeats keep system in NORMAL mode',
  precondition: Object.freeze({
    mode: 'NORMAL',
    budgetSpent: 0,
    budgetLimit: 200,
  }),
  steps: Object.freeze([
    Object.freeze({ t: 1000, inject: Object.freeze({ type: 'HEARTBEAT_LATE' as const, value: 1 }), description: 'Record heartbeat at t=1s' }),
    Object.freeze({ t: 5000, inject: Object.freeze({ type: 'HEARTBEAT_LATE' as const, value: 1 }), description: 'Record heartbeat at t=5s' }),
  ]),
  expected: Object.freeze({
    finalMode: 'NORMAL',
    invariants: Object.freeze(['STATE_FROZEN' as const, 'SAFE_TRANSITION' as const, 'AUDIT_INTEGRITY' as const]),
    shouldStop: false,
  }),
});

export const HEARTBEAT_SCENARIOS: readonly GameDayScenario[] = Object.freeze([
  heartbeatDead,
  heartbeatHealthy,
]);
