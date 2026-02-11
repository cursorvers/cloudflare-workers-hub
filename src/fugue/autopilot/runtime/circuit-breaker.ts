export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerConfig {
  readonly failureThreshold: number; // default 5
  readonly cooldownMs: number; // default 30000 (30s)
}

export interface CircuitBreakerState {
  readonly state: CircuitState;
  readonly consecutiveFailures: number;
  readonly lastFailureMs: number | null;
  readonly totalFailures: number;
  readonly totalSuccesses: number;
}

export interface CircuitBreakerResult {
  readonly allowed: boolean;
  readonly state: CircuitState;
  readonly reason: string;
}

export const DEFAULT_CIRCUIT_CONFIG: CircuitBreakerConfig = Object.freeze({
  failureThreshold: 5,
  cooldownMs: 30000,
});

function freezeState(state: CircuitBreakerState): CircuitBreakerState {
  return Object.freeze({ ...state });
}

function freezeResult(result: CircuitBreakerResult): CircuitBreakerResult {
  return Object.freeze({ ...result });
}

function safeNow(nowMs?: number): number {
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) {
    return Date.now();
  }
  return nowMs;
}

function isCircuitState(value: unknown): value is CircuitState {
  return value === 'CLOSED' || value === 'OPEN' || value === 'HALF_OPEN';
}

function isValidCounter(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

function validateConfig(config: CircuitBreakerConfig): boolean {
  return (
    Number.isInteger(config.failureThreshold) &&
    config.failureThreshold > 0 &&
    Number.isFinite(config.cooldownMs) &&
    config.cooldownMs >= 0
  );
}

function validateState(state: CircuitBreakerState): boolean {
  return (
    isCircuitState(state.state) &&
    isValidCounter(state.consecutiveFailures) &&
    (state.lastFailureMs === null ||
      (Number.isFinite(state.lastFailureMs) && state.lastFailureMs >= 0)) &&
    isValidCounter(state.totalFailures) &&
    isValidCounter(state.totalSuccesses)
  );
}

function failClosedState(nowMs: number): CircuitBreakerState {
  return freezeState({
    state: 'OPEN',
    consecutiveFailures: 0,
    lastFailureMs: nowMs,
    totalFailures: 0,
    totalSuccesses: 0,
  });
}

// Initial state is healthy/closed.
export function createCircuitBreakerState(): CircuitBreakerState {
  return freezeState({
    state: 'CLOSED',
    consecutiveFailures: 0,
    lastFailureMs: null,
    totalFailures: 0,
    totalSuccesses: 0,
  });
}

// Admission gate. Fail-closed on invalid state/config/time.
export function shouldAllowRequest(
  state: CircuitBreakerState,
  config: CircuitBreakerConfig = DEFAULT_CIRCUIT_CONFIG,
  nowMs?: number,
): CircuitBreakerResult {
  const now = safeNow(nowMs);

  if (!validateConfig(config)) {
    return freezeResult({
      allowed: false,
      state: 'OPEN',
      reason: 'fail-closed: invalid config',
    });
  }

  if (typeof nowMs === 'number' && !Number.isFinite(nowMs)) {
    return freezeResult({
      allowed: false,
      state: 'OPEN',
      reason: 'fail-closed: invalid nowMs',
    });
  }

  if (!validateState(state)) {
    return freezeResult({
      allowed: false,
      state: 'OPEN',
      reason: 'fail-closed: invalid state',
    });
  }

  if (state.state === 'CLOSED') {
    return freezeResult({
      allowed: true,
      state: 'CLOSED',
      reason: 'closed: request allowed',
    });
  }

  if (state.state === 'HALF_OPEN') {
    return freezeResult({
      allowed: true,
      state: 'HALF_OPEN',
      reason: 'half-open: single trial allowed',
    });
  }

  const lastFailureMs = state.lastFailureMs;
  if (lastFailureMs === null || now < lastFailureMs) {
    return freezeResult({
      allowed: false,
      state: 'OPEN',
      reason: 'open: cooldown not satisfied',
    });
  }

  const elapsed = now - lastFailureMs;
  if (elapsed >= config.cooldownMs) {
    return freezeResult({
      allowed: true,
      state: 'HALF_OPEN',
      reason: 'open->half-open: cooldown elapsed',
    });
  }

  return freezeResult({
    allowed: false,
    state: 'OPEN',
    reason: `open: cooldown remaining ${Math.max(0, config.cooldownMs - elapsed)}ms`,
  });
}

export function recordSuccess(state: CircuitBreakerState): CircuitBreakerState {
  const now = Date.now();

  if (!validateState(state)) {
    return failClosedState(now);
  }

  if (state.state === 'HALF_OPEN') {
    return freezeState({
      state: 'CLOSED',
      consecutiveFailures: 0,
      lastFailureMs: null,
      totalFailures: state.totalFailures,
      totalSuccesses: state.totalSuccesses + 1,
    });
  }

  if (state.state === 'CLOSED') {
    return freezeState({
      state: 'CLOSED',
      consecutiveFailures: 0,
      lastFailureMs: state.lastFailureMs,
      totalFailures: state.totalFailures,
      totalSuccesses: state.totalSuccesses + 1,
    });
  }

  // Conservative behavior: success signals in OPEN do not auto-close.
  return freezeState({
    state: 'OPEN',
    consecutiveFailures: state.consecutiveFailures,
    lastFailureMs: state.lastFailureMs,
    totalFailures: state.totalFailures,
    totalSuccesses: state.totalSuccesses + 1,
  });
}

export function recordFailure(
  state: CircuitBreakerState,
  config: CircuitBreakerConfig = DEFAULT_CIRCUIT_CONFIG,
  nowMs?: number,
): CircuitBreakerState {
  const now = safeNow(nowMs);

  if (!validateConfig(config)) {
    return failClosedState(now);
  }

  if (typeof nowMs === 'number' && !Number.isFinite(nowMs)) {
    return failClosedState(Date.now());
  }

  if (!validateState(state)) {
    return failClosedState(now);
  }

  if (state.state === 'HALF_OPEN') {
    return freezeState({
      state: 'OPEN',
      consecutiveFailures: Math.max(state.consecutiveFailures + 1, config.failureThreshold),
      lastFailureMs: now,
      totalFailures: state.totalFailures + 1,
      totalSuccesses: state.totalSuccesses,
    });
  }

  const nextConsecutiveFailures = state.consecutiveFailures + 1;
  const nextState: CircuitState =
    state.state === 'OPEN' || nextConsecutiveFailures >= config.failureThreshold
      ? 'OPEN'
      : 'CLOSED';

  return freezeState({
    state: nextState,
    consecutiveFailures: nextConsecutiveFailures,
    lastFailureMs: now,
    totalFailures: state.totalFailures + 1,
    totalSuccesses: state.totalSuccesses,
  });
}
