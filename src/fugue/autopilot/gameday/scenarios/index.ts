/**
 * GameDay Scenarios — All scenario exports.
 */

import { BUDGET_SCENARIOS } from './budget';
import { CIRCUIT_BREAKER_SCENARIOS } from './circuit-breaker';
import { HEARTBEAT_SCENARIOS } from './heartbeat';
import { MODE_TRANSITION_SCENARIOS } from './mode-transition';
import type { GameDayScenario } from '../types';

export { BUDGET_SCENARIOS } from './budget';
export { CIRCUIT_BREAKER_SCENARIOS } from './circuit-breaker';
export { HEARTBEAT_SCENARIOS } from './heartbeat';
export { MODE_TRANSITION_SCENARIOS } from './mode-transition';

/** All built-in GameDay scenarios for quarterly audit */
export const ALL_SCENARIOS: readonly GameDayScenario[] = Object.freeze([
  ...BUDGET_SCENARIOS,
  ...CIRCUIT_BREAKER_SCENARIOS,
  ...HEARTBEAT_SCENARIOS,
  ...MODE_TRANSITION_SCENARIOS,
]);
