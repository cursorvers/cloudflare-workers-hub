/**
 * Mode Machine — Extended Runtime Mode FSM
 *
 * Extends Phase 1/2 RuntimeMode (NORMAL | STOPPED) with intermediate
 * DEGRADED and RECOVERY modes for graceful degradation and self-healing.
 *
 * State transitions:
 *   STOPPED -> RECOVERY -> NORMAL (auto-recovery path)
 *   NORMAL  -> DEGRADED -> STOPPED (graceful degradation path)
 *   Any     -> STOPPED             (emergency / fail-closed)
 *   RECOVERY -> STOPPED            (recovery failed)
 *   DEGRADED -> NORMAL             (issue resolved)
 *
 * All functions are pure and return frozen objects.
 */

// =============================================================================
// Types
// =============================================================================

export type ExtendedMode = 'NORMAL' | 'DEGRADED' | 'RECOVERY' | 'STOPPED';

export interface ModeTransition {
  readonly from: ExtendedMode;
  readonly to: ExtendedMode;
  readonly reason: string;
  readonly timestamp: number;
  readonly success: boolean;
}

export interface ModeState {
  readonly mode: ExtendedMode;
  readonly previousMode: ExtendedMode | null;
  readonly lastTransition: ModeTransition | null;
  readonly transitionCount: number;
  readonly enteredCurrentModeAt: number;
}

export interface TransitionPolicy {
  readonly maxRecoveryDurationMs: number;
  readonly maxDegradedDurationMs: number;
  readonly autoRecoveryEnabled: boolean;
}

// =============================================================================
// Constants
// =============================================================================

export const EXTENDED_MODES = Object.freeze([
  'NORMAL',
  'DEGRADED',
  'RECOVERY',
  'STOPPED',
] as const);

export const DEFAULT_TRANSITION_POLICY: TransitionPolicy = Object.freeze({
  maxRecoveryDurationMs: 300_000,  // 5 minutes max in RECOVERY
  maxDegradedDurationMs: 600_000,  // 10 minutes max in DEGRADED
  autoRecoveryEnabled: true,
});

/**
 * Valid transition map: from -> allowed targets.
 */
const VALID_TRANSITIONS: ReadonlyMap<ExtendedMode, readonly ExtendedMode[]> = new Map([
  ['STOPPED', ['RECOVERY', 'NORMAL']],
  ['RECOVERY', ['NORMAL', 'STOPPED']],
  ['NORMAL', ['DEGRADED', 'STOPPED']],
  ['DEGRADED', ['NORMAL', 'STOPPED']],
]);

// =============================================================================
// Helpers
// =============================================================================

function isExtendedMode(value: unknown): value is ExtendedMode {
  return value === 'NORMAL' || value === 'DEGRADED' || value === 'RECOVERY' || value === 'STOPPED';
}

function safeNow(nowMs?: number): number {
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) {
    return Date.now();
  }
  return nowMs;
}

function freezeTransition(t: ModeTransition): ModeTransition {
  return Object.freeze({ ...t });
}

function freezeState(s: ModeState): ModeState {
  return Object.freeze({ ...s });
}

// =============================================================================
// Initial State
// =============================================================================

export function createInitialModeState(nowMs?: number): ModeState {
  const now = safeNow(nowMs);
  return freezeState({
    mode: 'STOPPED',
    previousMode: null,
    lastTransition: null,
    transitionCount: 0,
    enteredCurrentModeAt: now,
  });
}

// =============================================================================
// Transition Validation
// =============================================================================

/**
 * Check if a transition from -> to is valid per the FSM rules.
 * Emergency STOP is always allowed from any state.
 */
export function isValidTransition(from: ExtendedMode, to: ExtendedMode): boolean {
  // Emergency STOP always allowed
  if (to === 'STOPPED') return true;

  const allowed = VALID_TRANSITIONS.get(from);
  if (!allowed) return false;
  return allowed.includes(to);
}

/**
 * Get all valid target modes from the current mode.
 */
export function getValidTargets(from: ExtendedMode): readonly ExtendedMode[] {
  const targets = VALID_TRANSITIONS.get(from);
  if (!targets) return Object.freeze(['STOPPED'] as const);
  return Object.freeze([...targets]);
}

// =============================================================================
// Mode Transition (Pure)
// =============================================================================

/**
 * Attempt a mode transition. Returns a frozen ModeTransition result.
 * Fail-closed: invalid transitions go to STOPPED.
 */
export function attemptTransition(
  state: ModeState,
  targetMode: ExtendedMode,
  reason: string,
  nowMs?: number,
): ModeTransition {
  const now = safeNow(nowMs);
  const normalizedReason = reason.trim() || 'unspecified';

  // Validate current mode
  if (!isExtendedMode(state.mode)) {
    return freezeTransition({
      from: 'STOPPED',
      to: 'STOPPED',
      reason: `fail-closed: invalid current mode (${String(state.mode)})`,
      timestamp: now,
      success: false,
    });
  }

  // Validate target mode
  if (!isExtendedMode(targetMode)) {
    return freezeTransition({
      from: state.mode,
      to: 'STOPPED',
      reason: `fail-closed: invalid target mode (${String(targetMode)})`,
      timestamp: now,
      success: false,
    });
  }

  // Idempotent: same mode -> no-op success
  if (state.mode === targetMode) {
    return freezeTransition({
      from: state.mode,
      to: state.mode,
      reason: `idempotent no-op: ${normalizedReason}`,
      timestamp: now,
      success: true,
    });
  }

  // Check transition validity
  if (!isValidTransition(state.mode, targetMode)) {
    return freezeTransition({
      from: state.mode,
      to: 'STOPPED',
      reason: `fail-closed: invalid transition ${state.mode} -> ${targetMode} (${normalizedReason})`,
      timestamp: now,
      success: false,
    });
  }

  return freezeTransition({
    from: state.mode,
    to: targetMode,
    reason: normalizedReason,
    timestamp: now,
    success: true,
  });
}

/**
 * Apply a transition result to the state, producing new immutable state.
 */
export function applyModeTransition(
  state: ModeState,
  transition: ModeTransition,
): ModeState {
  // Validate transition payload
  if (!isExtendedMode(transition.from) || !isExtendedMode(transition.to)) {
    return freezeState({
      mode: 'STOPPED',
      previousMode: state.mode,
      lastTransition: freezeTransition({
        from: state.mode,
        to: 'STOPPED',
        reason: 'fail-closed: invalid transition payload',
        timestamp: transition.timestamp,
        success: false,
      }),
      transitionCount: state.transitionCount + 1,
      enteredCurrentModeAt: transition.timestamp,
    });
  }

  // CAS: reject stale transitions
  if (transition.from !== state.mode && transition.success) {
    return freezeState({
      mode: 'STOPPED',
      previousMode: state.mode,
      lastTransition: freezeTransition({
        from: state.mode,
        to: 'STOPPED',
        reason: 'fail-closed: stale transition (mode changed)',
        timestamp: transition.timestamp,
        success: false,
      }),
      transitionCount: state.transitionCount + 1,
      enteredCurrentModeAt: transition.timestamp,
    });
  }

  const nextMode = transition.success ? transition.to : 'STOPPED';
  const modeChanged = nextMode !== state.mode;

  return freezeState({
    mode: nextMode,
    previousMode: modeChanged ? state.mode : state.previousMode,
    lastTransition: transition,
    transitionCount: state.transitionCount + 1,
    enteredCurrentModeAt: modeChanged ? transition.timestamp : state.enteredCurrentModeAt,
  });
}

// =============================================================================
// Mode Duration Checks (Pure)
// =============================================================================

/**
 * Check if the current mode has exceeded its maximum allowed duration.
 * Only applies to DEGRADED and RECOVERY modes.
 */
export function checkModeTimeout(
  state: ModeState,
  policy: TransitionPolicy = DEFAULT_TRANSITION_POLICY,
  nowMs?: number,
): { readonly timedOut: boolean; readonly mode: ExtendedMode; readonly elapsedMs: number; readonly maxMs: number } {
  const now = safeNow(nowMs);
  const elapsed = now - state.enteredCurrentModeAt;

  if (state.mode === 'RECOVERY' && elapsed > policy.maxRecoveryDurationMs) {
    return Object.freeze({
      timedOut: true,
      mode: state.mode,
      elapsedMs: elapsed,
      maxMs: policy.maxRecoveryDurationMs,
    });
  }

  if (state.mode === 'DEGRADED' && elapsed > policy.maxDegradedDurationMs) {
    return Object.freeze({
      timedOut: true,
      mode: state.mode,
      elapsedMs: elapsed,
      maxMs: policy.maxDegradedDurationMs,
    });
  }

  const maxMs = state.mode === 'RECOVERY'
    ? policy.maxRecoveryDurationMs
    : state.mode === 'DEGRADED'
      ? policy.maxDegradedDurationMs
      : 0;

  return Object.freeze({
    timedOut: false,
    mode: state.mode,
    elapsedMs: elapsed,
    maxMs,
  });
}

// =============================================================================
// Operational Status (Pure)
// =============================================================================

/**
 * Check if the system is operational (accepting work).
 * NORMAL and DEGRADED are considered operational.
 */
export function isModeOperational(mode: ExtendedMode): boolean {
  return mode === 'NORMAL' || mode === 'DEGRADED';
}

/**
 * Check if the system is in a healthy state (no issues).
 */
export function isModeHealthy(mode: ExtendedMode): boolean {
  return mode === 'NORMAL';
}
