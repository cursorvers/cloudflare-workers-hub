/**
 * Budget and rate limiting types for FUGUE Autopilot.
 * State machine: NORMAL -> DEGRADED -> HALTED
 */

export const BUDGET_STATES = Object.freeze({
  NORMAL: 'NORMAL',
  DEGRADED: 'DEGRADED',
  HALTED: 'HALTED',
} as const);

export type BudgetState = (typeof BUDGET_STATES)[keyof typeof BUDGET_STATES];

/**
 * Budget configuration.
 *
 * - degradedThreshold: fraction of weeklyLimit that triggers DEGRADED (default 0.8)
 * - haltedThreshold: fraction of weeklyLimit that triggers HALTED (default 0.95)
 * - autoHaltTimeoutMs: ms after DEGRADED before auto-HALTED (default 300000 = 5min)
 */
export interface BudgetConfig {
  readonly weeklyLimit: number;
  readonly degradedThreshold: number;
  readonly haltedThreshold: number;
  readonly autoHaltTimeoutMs: number;
}

export const DEFAULT_BUDGET_CONFIG: BudgetConfig = Object.freeze({
  weeklyLimit: 200,
  degradedThreshold: 0.8,
  haltedThreshold: 0.95,
  autoHaltTimeoutMs: 300_000,
});

export interface BudgetStatus {
  readonly state: BudgetState;
  readonly used: number;
  readonly limit: number;
  readonly degradedAt?: string;
  readonly haltedAt?: string;
}
