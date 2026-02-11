import { describe, expect, it } from 'vitest';

import {
  checkIdleTimeout,
  createSafetyState,
  DEFAULT_SAFETY_CONFIG,
  DEFAULT_THRASHING_CONFIG,
  detectThrashing,
  recordFailure,
  recordSuccess,
} from '../safety-controller';

describe('safety/safety-controller', () => {
  it('createSafetyState returns clean initial state', () => {
    const state = createSafetyState();
    expect(state).toEqual({
      consecutiveFailures: 0,
      circuitBreakerOpen: false,
      lastFailureAt: null,
      recentErrors: [],
      idleTimeoutExceeded: false,
    });
  });

  it('recordFailure increments consecutiveFailures', () => {
    const state = recordFailure(createSafetyState(), 'error-1', DEFAULT_SAFETY_CONFIG);
    expect(state.consecutiveFailures).toBe(1);
    expect(state.recentErrors).toEqual(['error-1']);
  });

  it('recordFailure opens circuit breaker at threshold', () => {
    const s1 = recordFailure(createSafetyState(), 'error-1', DEFAULT_SAFETY_CONFIG);
    const s2 = recordFailure(s1, 'error-2', DEFAULT_SAFETY_CONFIG);
    expect(s2.consecutiveFailures).toBe(2);
    expect(s2.circuitBreakerOpen).toBe(true);
  });

  it('recordSuccess resets consecutiveFailures and closes circuit breaker', () => {
    const s1 = recordFailure(createSafetyState(), 'error-1', DEFAULT_SAFETY_CONFIG);
    const s2 = recordFailure(s1, 'error-2', DEFAULT_SAFETY_CONFIG);
    const s3 = recordSuccess(s2);

    expect(s3.consecutiveFailures).toBe(0);
    expect(s3.circuitBreakerOpen).toBe(false);
  });

  it('recentErrors capped at maxRecentErrors', () => {
    const config = { ...DEFAULT_SAFETY_CONFIG, maxRecentErrors: 3 };
    let state = createSafetyState();
    state = recordFailure(state, 'e1', config);
    state = recordFailure(state, 'e2', config);
    state = recordFailure(state, 'e3', config);
    state = recordFailure(state, 'e4', config);

    expect(state.recentErrors).toEqual(['e2', 'e3', 'e4']);
  });

  it('checkIdleTimeout sets idleTimeoutExceeded correctly', () => {
    const nowMs = Date.parse('2026-01-10T12:00:00.000Z');
    const oldLastActivity = '2026-01-06T11:59:59.000Z';
    const freshLastActivity = '2026-01-10T11:00:00.000Z';

    const exceeded = checkIdleTimeout(
      createSafetyState(),
      oldLastActivity,
      DEFAULT_SAFETY_CONFIG,
      nowMs,
    );
    const fresh = checkIdleTimeout(
      createSafetyState(),
      freshLastActivity,
      DEFAULT_SAFETY_CONFIG,
      nowMs,
    );

    expect(exceeded.idleTimeoutExceeded).toBe(true);
    expect(fresh.idleTimeoutExceeded).toBe(false);
  });

  it('detectThrashing returns true when consecutive identical errors >= maxFixCycles', () => {
    const result = detectThrashing(['x', 'x', 'x'], DEFAULT_THRASHING_CONFIG);
    expect(result).toBe(true);
  });

  it('detectThrashing returns false when errors are different', () => {
    const result = detectThrashing(['x', 'y', 'x', 'y'], DEFAULT_THRASHING_CONFIG);
    expect(result).toBe(false);
  });

  it('all states are frozen', () => {
    const initial = createSafetyState();
    const failed = recordFailure(initial, 'err', DEFAULT_SAFETY_CONFIG);
    const succeeded = recordSuccess(failed);
    const idle = checkIdleTimeout(succeeded, new Date().toISOString(), DEFAULT_SAFETY_CONFIG);

    expect(Object.isFrozen(initial)).toBe(true);
    expect(Object.isFrozen(failed)).toBe(true);
    expect(Object.isFrozen(failed.recentErrors)).toBe(true);
    expect(Object.isFrozen(succeeded)).toBe(true);
    expect(Object.isFrozen(idle)).toBe(true);
  });
});
