import { describe, expect, it } from 'vitest';

import {
  createCircuitBreakerState,
  DEFAULT_CIRCUIT_CONFIG,
  recordFailure,
  recordSuccess,
  shouldAllowRequest,
} from '../circuit-breaker';

describe('runtime/circuit-breaker', () => {
  it('初期状態がCLOSED/allowed', () => {
    const state = createCircuitBreakerState();
    const result = shouldAllowRequest(state, DEFAULT_CIRCUIT_CONFIG, 1000);

    expect(state.state).toBe('CLOSED');
    expect(result.allowed).toBe(true);
    expect(result.state).toBe('CLOSED');
  });

  it('連続失敗でOPEN遷移', () => {
    const config = { failureThreshold: 3, cooldownMs: 30000 } as const;
    const s0 = createCircuitBreakerState();
    const s1 = recordFailure(s0, config, 1000);
    const s2 = recordFailure(s1, config, 1100);
    const s3 = recordFailure(s2, config, 1200);

    expect(s1.state).toBe('CLOSED');
    expect(s2.state).toBe('CLOSED');
    expect(s3.state).toBe('OPEN');
    expect(s3.consecutiveFailures).toBe(3);
  });

  it('OPEN状態でrequest拒否', () => {
    const config = { failureThreshold: 1, cooldownMs: 30000 } as const;
    const open = recordFailure(createCircuitBreakerState(), config, 1000);
    const result = shouldAllowRequest(open, config, 2000);

    expect(open.state).toBe('OPEN');
    expect(result.allowed).toBe(false);
    expect(result.state).toBe('OPEN');
  });

  it('cooldown後にHALF_OPEN遷移+1回許可', () => {
    const config = { failureThreshold: 1, cooldownMs: 3000 } as const;
    const open = recordFailure(createCircuitBreakerState(), config, 1000);
    const result = shouldAllowRequest(open, config, 4000);

    expect(result.allowed).toBe(true);
    expect(result.state).toBe('HALF_OPEN');
    expect(result.reason).toContain('cooldown elapsed');
  });

  it('HALF_OPEN成功でCLOSED復帰', () => {
    const halfOpen = Object.freeze({
      state: 'HALF_OPEN' as const,
      consecutiveFailures: 3,
      lastFailureMs: 1000,
      totalFailures: 3,
      totalSuccesses: 0,
    });
    const next = recordSuccess(halfOpen);

    expect(next.state).toBe('CLOSED');
    expect(next.consecutiveFailures).toBe(0);
    expect(next.lastFailureMs).toBeNull();
    expect(next.totalSuccesses).toBe(1);
  });

  it('HALF_OPEN失敗で再OPEN', () => {
    const config = { failureThreshold: 5, cooldownMs: 30000 } as const;
    const halfOpen = Object.freeze({
      state: 'HALF_OPEN' as const,
      consecutiveFailures: 2,
      lastFailureMs: 1000,
      totalFailures: 2,
      totalSuccesses: 1,
    });
    const next = recordFailure(halfOpen, config, 2000);

    expect(next.state).toBe('OPEN');
    expect(next.lastFailureMs).toBe(2000);
    expect(next.totalFailures).toBe(3);
  });

  it('recordSuccess/recordFailureで不変性', () => {
    const base = createCircuitBreakerState();
    const success = recordSuccess(base);
    const failure = recordFailure(base, DEFAULT_CIRCUIT_CONFIG, 1000);

    expect(success).not.toBe(base);
    expect(failure).not.toBe(base);
    expect(base.totalSuccesses).toBe(0);
    expect(base.totalFailures).toBe(0);
    expect(success.totalSuccesses).toBe(1);
    expect(failure.totalFailures).toBe(1);
  });

  it('全結果がObject.freeze', () => {
    const state = createCircuitBreakerState();
    const allowed = shouldAllowRequest(state, DEFAULT_CIRCUIT_CONFIG, 1000);
    const failed = recordFailure(state, DEFAULT_CIRCUIT_CONFIG, 1000);
    const succeeded = recordSuccess(state);

    expect(Object.isFrozen(DEFAULT_CIRCUIT_CONFIG)).toBe(true);
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(allowed)).toBe(true);
    expect(Object.isFrozen(failed)).toBe(true);
    expect(Object.isFrozen(succeeded)).toBe(true);
  });
});
