import type { ExtendedMode, ModeState, TransitionPolicy } from './mode-machine';
import {
  createInitialModeState,
  attemptTransition as extAttemptTransition,
  applyModeTransition as extApplyTransition,
  isModeOperational,
  isModeHealthy,
  checkModeTimeout,
  isValidTransition,
  EXTENDED_MODES,
  DEFAULT_TRANSITION_POLICY,
} from './mode-machine';

// Re-export extended mode types and functions for downstream consumers
export type { ExtendedMode, ModeState, TransitionPolicy };
export {
  EXTENDED_MODES,
  DEFAULT_TRANSITION_POLICY,
  createInitialModeState,
  isValidTransition,
  isModeOperational,
  isModeHealthy,
  checkModeTimeout,
};

// =============================================================================
// Legacy Types (backward compatible — NORMAL | STOPPED)
// =============================================================================

export type RuntimeMode = 'NORMAL' | 'STOPPED';

export interface ModeTransitionResult {
  readonly success: boolean;
  readonly previousMode: RuntimeMode;
  readonly currentMode: RuntimeMode;
  readonly reason: string;
  readonly timestamp: number;
}

export interface RuntimeState {
  readonly mode: RuntimeMode;
  readonly lastTransition: ModeTransitionResult | null;
  readonly transitionCount: number;
}

// =============================================================================
// Extended State (Phase 3: 4-mode support)
// =============================================================================

export interface ExtendedRuntimeState {
  readonly mode: ExtendedMode;
  readonly previousMode: ExtendedMode | null;
  readonly lastTransition: ModeTransitionResult | null;
  readonly transitionCount: number;
  readonly enteredCurrentModeAt: number;
}

// =============================================================================
// Mode Checks & Conversions
// =============================================================================

const RUNTIME_MODES = Object.freeze({
  NORMAL: 'NORMAL',
  STOPPED: 'STOPPED',
} as const);

function isRuntimeMode(value: unknown): value is RuntimeMode {
  return value === RUNTIME_MODES.NORMAL || value === RUNTIME_MODES.STOPPED;
}

function isExtendedMode(value: unknown): value is ExtendedMode {
  return value === 'NORMAL' || value === 'DEGRADED' || value === 'RECOVERY' || value === 'STOPPED';
}

/**
 * Convert ExtendedMode to legacy RuntimeMode.
 * DEGRADED and RECOVERY map to NORMAL (operational) and STOPPED respectively
 * for legacy consumers that only understand NORMAL/STOPPED.
 */
export function toLegacyMode(mode: ExtendedMode): RuntimeMode {
  switch (mode) {
    case 'NORMAL':
    case 'DEGRADED':
      return 'NORMAL';
    case 'RECOVERY':
    case 'STOPPED':
      return 'STOPPED';
  }
}

/**
 * Check if an extended mode is operational (NORMAL or DEGRADED).
 */
export function isExtendedOperational(mode: ExtendedMode): boolean {
  return isModeOperational(mode);
}

/**
 * Create an initial ExtendedRuntimeState (STOPPED, fail-closed).
 */
export function createInitialExtendedState(nowMs?: number): ExtendedRuntimeState {
  const modeState = createInitialModeState(nowMs);
  return Object.freeze({
    mode: modeState.mode,
    previousMode: modeState.previousMode,
    lastTransition: null,
    transitionCount: 0,
    enteredCurrentModeAt: modeState.enteredCurrentModeAt,
  });
}

/**
 * Transition ExtendedRuntimeState to a new mode with FSM validation.
 */
export function transitionExtendedMode(
  state: ExtendedRuntimeState,
  targetMode: ExtendedMode,
  reason: string,
  nowMs?: number,
): ModeTransitionResult {
  const modeState: ModeState = Object.freeze({
    mode: state.mode,
    previousMode: state.previousMode,
    lastTransition: null,
    transitionCount: state.transitionCount,
    enteredCurrentModeAt: state.enteredCurrentModeAt,
  });

  const transition = extAttemptTransition(modeState, targetMode, reason, nowMs);

  // Map to legacy ModeTransitionResult format
  return Object.freeze({
    success: transition.success,
    previousMode: toLegacyMode(transition.from),
    currentMode: toLegacyMode(transition.to),
    reason: transition.reason,
    timestamp: transition.timestamp,
  });
}

/**
 * Apply transition to ExtendedRuntimeState, producing new immutable state.
 */
export function applyExtendedTransition(
  state: ExtendedRuntimeState,
  targetMode: ExtendedMode,
  reason: string,
  nowMs?: number,
): ExtendedRuntimeState {
  const modeState: ModeState = Object.freeze({
    mode: state.mode,
    previousMode: state.previousMode,
    lastTransition: null,
    transitionCount: state.transitionCount,
    enteredCurrentModeAt: state.enteredCurrentModeAt,
  });

  const transition = extAttemptTransition(modeState, targetMode, reason, nowMs);
  const newModeState = extApplyTransition(modeState, transition);

  const legacyTransition: ModeTransitionResult = Object.freeze({
    success: transition.success,
    previousMode: toLegacyMode(transition.from),
    currentMode: toLegacyMode(transition.to),
    reason: transition.reason,
    timestamp: transition.timestamp,
  });

  return Object.freeze({
    mode: newModeState.mode,
    previousMode: newModeState.previousMode,
    lastTransition: legacyTransition,
    transitionCount: newModeState.transitionCount,
    enteredCurrentModeAt: newModeState.enteredCurrentModeAt,
  });
}

function normalizeReason(reason: string): string {
  const trimmed = reason.trim();
  return trimmed.length > 0 ? trimmed : 'unspecified';
}

function safeNow(nowMs?: number): number {
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) {
    return Date.now();
  }
  return nowMs;
}

function freezeTransition(result: ModeTransitionResult): ModeTransitionResult {
  return Object.freeze({ ...result });
}

function failClosed(
  previousMode: RuntimeMode,
  reason: string,
  nowMs?: number,
): ModeTransitionResult {
  return freezeTransition({
    success: false,
    previousMode,
    currentMode: RUNTIME_MODES.STOPPED,
    reason,
    timestamp: safeNow(nowMs),
  });
}

// Initial state: STOPPED (fail-closed).
export function createInitialState(): RuntimeState {
  return Object.freeze({
    mode: RUNTIME_MODES.STOPPED,
    lastTransition: null,
    transitionCount: 0,
  });
}

// Mode transition with exclusivity and idempotency.
export function transitionMode(
  state: RuntimeState,
  targetMode: RuntimeMode,
  reason: string,
  nowMs?: number,
): ModeTransitionResult {
  const timestamp = safeNow(nowMs);
  const normalizedReason = normalizeReason(reason);

  try {
    if (!isRuntimeMode(state.mode)) {
      return failClosed(
        RUNTIME_MODES.STOPPED,
        `fail-closed: invalid state mode (${String(state.mode)})`,
        timestamp,
      );
    }

    if (!isRuntimeMode(targetMode)) {
      return failClosed(
        state.mode,
        `fail-closed: invalid target mode (${String(targetMode)})`,
        timestamp,
      );
    }

    // Idempotent: same mode transition is a no-op success.
    if (state.mode === targetMode) {
      return freezeTransition({
        success: true,
        previousMode: state.mode,
        currentMode: state.mode,
        reason: `idempotent no-op: ${normalizedReason}`,
        timestamp,
      });
    }

    return freezeTransition({
      success: true,
      previousMode: state.mode,
      currentMode: targetMode,
      reason: normalizedReason,
      timestamp,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    const previousMode = isRuntimeMode(state.mode) ? state.mode : RUNTIME_MODES.STOPPED;
    return failClosed(previousMode, `fail-closed: internal error (${message})`, timestamp);
  }
}

// Apply transition result to produce new immutable state.
export function applyTransition(
  state: RuntimeState,
  result: ModeTransitionResult,
): RuntimeState {
  const fallbackPrevious = isRuntimeMode(state.mode) ? state.mode : RUNTIME_MODES.STOPPED;
  const fallbackTimestamp = safeNow(result.timestamp);

  if (!isRuntimeMode(state.mode)) {
    const forced = failClosed(
      fallbackPrevious,
      `fail-closed: invalid state mode during apply (${String(state.mode)})`,
      fallbackTimestamp,
    );
    return Object.freeze({
      mode: RUNTIME_MODES.STOPPED,
      lastTransition: forced,
      transitionCount: state.transitionCount + 1,
    });
  }

  if (!isRuntimeMode(result.previousMode) || !isRuntimeMode(result.currentMode)) {
    const forced = failClosed(
      state.mode,
      'fail-closed: invalid transition payload',
      fallbackTimestamp,
    );
    return Object.freeze({
      mode: RUNTIME_MODES.STOPPED,
      lastTransition: forced,
      transitionCount: state.transitionCount + 1,
    });
  }

  // CAS: reject stale transitions (exclusive transition enforcement).
  if (result.previousMode !== state.mode) {
    const forced = failClosed(
      state.mode,
      'fail-closed: stale transition detected (exclusive transition violation)',
      fallbackTimestamp,
    );
    return Object.freeze({
      mode: RUNTIME_MODES.STOPPED,
      lastTransition: forced,
      transitionCount: state.transitionCount + 1,
    });
  }

  const nextMode = result.success ? result.currentMode : RUNTIME_MODES.STOPPED;
  return Object.freeze({
    mode: nextMode,
    lastTransition: freezeTransition(result),
    transitionCount: state.transitionCount + 1,
  });
}

// Check whether the runtime is operational (legacy: NORMAL only).
export function isOperational(state: RuntimeState): boolean {
  return state.mode === RUNTIME_MODES.NORMAL;
}

// Check whether the extended runtime is operational (NORMAL or DEGRADED).
export function isExtendedStateOperational(state: ExtendedRuntimeState): boolean {
  return isModeOperational(state.mode);
}
