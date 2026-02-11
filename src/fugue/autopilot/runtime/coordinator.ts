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

const RUNTIME_MODES = Object.freeze({
  NORMAL: 'NORMAL',
  STOPPED: 'STOPPED',
} as const);

function isRuntimeMode(value: unknown): value is RuntimeMode {
  return value === RUNTIME_MODES.NORMAL || value === RUNTIME_MODES.STOPPED;
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

// Check whether the runtime is operational.
export function isOperational(state: RuntimeState): boolean {
  return state.mode === RUNTIME_MODES.NORMAL;
}
