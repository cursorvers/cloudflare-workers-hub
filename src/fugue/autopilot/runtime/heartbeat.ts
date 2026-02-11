export type HeartbeatStatus = 'ALIVE' | 'LATE' | 'DEAD';

export interface HeartbeatConfig {
  readonly intervalMs: number; // default 10000 (10s)
  readonly lateThresholdMs: number; // default 15000 (1.5x interval)
  readonly deadThresholdMs: number; // default 30000 (3x interval)
  readonly gracePeriodMs: number; // default 30000 (startup grace)
}

export interface HeartbeatState {
  readonly lastHeartbeatMs: number | null;
  readonly startedAtMs: number;
  readonly consecutiveMisses: number;
  readonly totalHeartbeats: number;
}

export interface HeartbeatCheckResult {
  readonly status: HeartbeatStatus;
  readonly shouldStop: boolean;
  readonly msSinceLastBeat: number | null;
  readonly reason: string;
}

export const DEFAULT_HEARTBEAT_CONFIG: HeartbeatConfig = Object.freeze({
  intervalMs: 10000,
  lateThresholdMs: 15000,
  deadThresholdMs: 30000,
  gracePeriodMs: 30000,
});

function freezeState(state: HeartbeatState): HeartbeatState {
  return Object.freeze({ ...state });
}

function freezeResult(result: HeartbeatCheckResult): HeartbeatCheckResult {
  return Object.freeze({ ...result });
}

function safeNow(nowMs?: number): number {
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) {
    return Date.now();
  }
  return nowMs;
}

function isValidNonNegativeInt(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

function validateConfig(config: HeartbeatConfig): boolean {
  return (
    Number.isFinite(config.intervalMs) &&
    config.intervalMs > 0 &&
    Number.isFinite(config.lateThresholdMs) &&
    config.lateThresholdMs >= config.intervalMs &&
    Number.isFinite(config.deadThresholdMs) &&
    config.deadThresholdMs >= config.lateThresholdMs &&
    Number.isFinite(config.gracePeriodMs) &&
    config.gracePeriodMs >= 0
  );
}

function validateState(state: HeartbeatState): boolean {
  return (
    (state.lastHeartbeatMs === null ||
      (Number.isFinite(state.lastHeartbeatMs) && state.lastHeartbeatMs >= 0)) &&
    Number.isFinite(state.startedAtMs) &&
    state.startedAtMs >= 0 &&
    isValidNonNegativeInt(state.consecutiveMisses) &&
    isValidNonNegativeInt(state.totalHeartbeats)
  );
}

function failClosedState(state: HeartbeatState, nowMs: number): HeartbeatState {
  const baseStartedAt =
    Number.isFinite(state.startedAtMs) && state.startedAtMs >= 0 ? state.startedAtMs : nowMs;
  const baseMisses =
    Number.isInteger(state.consecutiveMisses) && state.consecutiveMisses >= 0
      ? state.consecutiveMisses
      : 0;
  const baseHeartbeats =
    Number.isInteger(state.totalHeartbeats) && state.totalHeartbeats >= 0
      ? state.totalHeartbeats
      : 0;

  return freezeState({
    lastHeartbeatMs: null,
    startedAtMs: baseStartedAt,
    consecutiveMisses: baseMisses + 1,
    totalHeartbeats: baseHeartbeats,
  });
}

function buildStatusResult(
  status: HeartbeatStatus,
  msSinceLastBeat: number | null,
  reason: string,
): HeartbeatCheckResult {
  return freezeResult({
    status,
    shouldStop: status === 'DEAD',
    msSinceLastBeat,
    reason,
  });
}

// Initial state: no heartbeat yet.
export function createHeartbeatState(startedAtMs: number): HeartbeatState {
  const safeStartedAt =
    Number.isFinite(startedAtMs) && startedAtMs >= 0 ? startedAtMs : 0;

  return freezeState({
    lastHeartbeatMs: null,
    startedAtMs: safeStartedAt,
    consecutiveMisses: 0,
    totalHeartbeats: 0,
  });
}

// Records heartbeat reception and resets misses. Fail-closed on invalid state/time.
export function recordHeartbeat(
  state: HeartbeatState,
  nowMs: number,
): HeartbeatState {
  const now = safeNow(nowMs);

  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) {
    return failClosedState(state, now);
  }

  if (!validateState(state)) {
    return failClosedState(state, now);
  }

  if (now < state.startedAtMs) {
    return failClosedState(state, now);
  }

  return freezeState({
    lastHeartbeatMs: now,
    startedAtMs: state.startedAtMs,
    consecutiveMisses: 0,
    totalHeartbeats: state.totalHeartbeats + 1,
  });
}

// Heartbeat liveness check. Fail-closed on invalid state/config/time.
export function checkHeartbeat(
  state: HeartbeatState,
  config: HeartbeatConfig = DEFAULT_HEARTBEAT_CONFIG,
  nowMs?: number,
): HeartbeatCheckResult {
  const now = safeNow(nowMs);

  if (typeof nowMs === 'number' && !Number.isFinite(nowMs)) {
    return buildStatusResult('DEAD', null, 'fail-closed: invalid nowMs');
  }

  if (!validateConfig(config)) {
    return buildStatusResult('DEAD', null, 'fail-closed: invalid config');
  }

  if (!validateState(state)) {
    return buildStatusResult('DEAD', null, 'fail-closed: invalid state');
  }

  if (now < state.startedAtMs) {
    return buildStatusResult('DEAD', null, 'fail-closed: nowMs earlier than startedAtMs');
  }

  const elapsedSinceStart = now - state.startedAtMs;

  if (state.lastHeartbeatMs === null && elapsedSinceStart <= config.gracePeriodMs) {
    return buildStatusResult(
      'ALIVE',
      null,
      `startup grace: ${elapsedSinceStart}ms <= gracePeriod ${config.gracePeriodMs}ms`,
    );
  }

  const referenceMs = state.lastHeartbeatMs ?? state.startedAtMs;
  const msSinceLastBeat = now - referenceMs;

  if (!Number.isFinite(msSinceLastBeat) || msSinceLastBeat < 0) {
    return buildStatusResult('DEAD', null, 'fail-closed: invalid elapsed heartbeat time');
  }

  const inferredConsecutiveMisses = Math.max(
    state.consecutiveMisses,
    Math.floor(Math.max(0, msSinceLastBeat - 1) / config.intervalMs),
  );

  if (msSinceLastBeat >= config.deadThresholdMs) {
    return buildStatusResult(
      'DEAD',
      msSinceLastBeat,
      `dead: ${msSinceLastBeat}ms >= deadThreshold ${config.deadThresholdMs}ms (consecutiveMisses=${inferredConsecutiveMisses})`,
    );
  }

  if (msSinceLastBeat > config.intervalMs || msSinceLastBeat >= config.lateThresholdMs) {
    return buildStatusResult(
      'LATE',
      msSinceLastBeat,
      `late: ${msSinceLastBeat}ms > interval ${config.intervalMs}ms (consecutiveMisses=${inferredConsecutiveMisses})`,
    );
  }

  return buildStatusResult(
    'ALIVE',
    msSinceLastBeat,
    `alive: ${msSinceLastBeat}ms <= interval ${config.intervalMs}ms`,
  );
}
