export interface SafetyState {
  readonly consecutiveFailures: number;
  readonly circuitBreakerOpen: boolean;
  readonly lastFailureAt: string | null;
  readonly recentErrors: readonly string[];
  readonly idleTimeoutExceeded: boolean;
}

export interface SafetyConfig {
  readonly maxConsecutiveFailures: number;
  readonly maxRecentErrors: number;
  readonly idleTimeoutMs: number;
}

export interface ThrashingConfig {
  readonly maxFixCycles: number;
  readonly similarityThreshold: number;
}

export const DEFAULT_SAFETY_CONFIG: SafetyConfig = Object.freeze({
  maxConsecutiveFailures: 2,
  maxRecentErrors: 10,
  idleTimeoutMs: 72 * 60 * 60 * 1000,
});

export const DEFAULT_THRASHING_CONFIG: ThrashingConfig = Object.freeze({
  maxFixCycles: 3,
  similarityThreshold: 0.92,
});

function nowIso(nowMs: number = Date.now()): string {
  return new Date(nowMs).toISOString();
}

function freezeErrors(errors: readonly string[]): readonly string[] {
  return Object.freeze([...errors]);
}

export function createSafetyState(): SafetyState {
  return Object.freeze({
    consecutiveFailures: 0,
    circuitBreakerOpen: false,
    lastFailureAt: null,
    recentErrors: freezeErrors([]),
    idleTimeoutExceeded: false,
  });
}

export function recordFailure(
  state: SafetyState,
  error: string,
  config: SafetyConfig,
): SafetyState {
  const consecutiveFailures = state.consecutiveFailures + 1;
  const nextErrors = [...state.recentErrors, error].slice(-config.maxRecentErrors);
  return Object.freeze({
    consecutiveFailures,
    circuitBreakerOpen: consecutiveFailures >= config.maxConsecutiveFailures,
    lastFailureAt: nowIso(),
    recentErrors: freezeErrors(nextErrors),
    idleTimeoutExceeded: state.idleTimeoutExceeded,
  });
}

export function recordSuccess(state: SafetyState): SafetyState {
  return Object.freeze({
    consecutiveFailures: 0,
    circuitBreakerOpen: false,
    lastFailureAt: state.lastFailureAt,
    recentErrors: freezeErrors(state.recentErrors),
    idleTimeoutExceeded: state.idleTimeoutExceeded,
  });
}

export function checkIdleTimeout(
  state: SafetyState,
  lastActivityAt: string,
  config: SafetyConfig,
  nowMs: number = Date.now(),
): SafetyState {
  const lastActivityMs = Date.parse(lastActivityAt);
  const exceeded = Number.isFinite(lastActivityMs)
    ? nowMs - lastActivityMs > config.idleTimeoutMs
    : false;
  return Object.freeze({
    consecutiveFailures: state.consecutiveFailures,
    circuitBreakerOpen: state.circuitBreakerOpen,
    lastFailureAt: state.lastFailureAt,
    recentErrors: freezeErrors(state.recentErrors),
    idleTimeoutExceeded: exceeded,
  });
}

export function detectThrashing(
  recentErrors: readonly string[],
  config: ThrashingConfig,
): boolean {
  if (recentErrors.length === 0) return false;
  let consecutiveSame = 1;
  for (let i = 1; i < recentErrors.length; i += 1) {
    if (recentErrors[i] === recentErrors[i - 1]) {
      consecutiveSame += 1;
      if (consecutiveSame >= config.maxFixCycles) return true;
      continue;
    }
    consecutiveSame = 1;
  }
  return false;
}
