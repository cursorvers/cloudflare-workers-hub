/**
 * SafetySentinel DO — Shared Types
 *
 * Type definitions shared between SafetySentinel DO and its consumers.
 */

import type { RuntimeMode, ModeTransitionResult } from '../runtime/coordinator';
import type { GuardCheckResult } from '../runtime/runtime-guard';
import type { HeartbeatState } from '../runtime/heartbeat';
import type { CircuitBreakerState } from '../runtime/circuit-breaker';

// =============================================================================
// Request / Response Types
// =============================================================================

export interface SentinelStatus {
  readonly mode: RuntimeMode;
  readonly isOperational: boolean;
  readonly lastGuardCheck: GuardCheckResult | null;
  readonly heartbeatState: HeartbeatState;
  readonly circuitBreakerState: CircuitBreakerState;
  readonly budgetSpent: number;
  readonly budgetLimit: number;
  readonly timestamp: number;
}

export interface SentinelBudgetUpdate {
  readonly spent: number;
  readonly limit: number;
}

export interface SentinelGuardResult {
  readonly guardCheck: GuardCheckResult;
  readonly autoStopped: boolean;
  readonly transition: ModeTransitionResult | null;
}

// =============================================================================
// HTTP Route Map
// =============================================================================

export const SENTINEL_ROUTES = Object.freeze({
  STATUS: '/status',
  GUARD: '/guard',
  HEARTBEAT: '/heartbeat',
  CIRCUIT_SUCCESS: '/circuit/success',
  CIRCUIT_FAILURE: '/circuit/failure',
  BUDGET: '/budget',
  TRANSITION: '/transition',
} as const);
