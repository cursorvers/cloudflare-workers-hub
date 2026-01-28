/**
 * Tests for Circuit Breaker
 *
 * Tests covering:
 * - State transitions (CLOSED → OPEN → HALF_OPEN → CLOSED)
 * - Failure threshold behavior
 * - Success threshold in HALF_OPEN state
 * - Reset timeout behavior
 * - CircuitOpenError
 * - Stats tracking
 * - Manual reset
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CircuitBreaker, CircuitOpenError } from './circuit-breaker';

// Mock log-sanitizer
vi.mock('./log-sanitizer', () => ({
  safeLog: {
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('Circuit Breaker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ==========================================================================
  // CLOSED state (normal operation)
  // ==========================================================================
  describe('CLOSED state', () => {
    it('should execute function and return result', async () => {
      const cb = new CircuitBreaker('test');
      const result = await cb.execute(() => Promise.resolve('success'));
      expect(result).toBe('success');
    });

    it('should start in CLOSED state', () => {
      const cb = new CircuitBreaker('test');
      expect(cb.getStats().state).toBe('CLOSED');
    });

    it('should propagate errors without opening circuit (below threshold)', async () => {
      const cb = new CircuitBreaker('test', { failureThreshold: 5 });

      for (let i = 0; i < 4; i++) {
        await expect(cb.execute(() => Promise.reject(new Error('fail')))).rejects.toThrow('fail');
      }

      expect(cb.getStats().state).toBe('CLOSED');
      expect(cb.getStats().failures).toBe(4);
    });

    it('should reset failure counter on success', async () => {
      const cb = new CircuitBreaker('test', { failureThreshold: 5 });

      // 3 failures
      for (let i = 0; i < 3; i++) {
        await expect(cb.execute(() => Promise.reject(new Error('fail')))).rejects.toThrow();
      }

      // 1 success resets counter
      await cb.execute(() => Promise.resolve('ok'));
      expect(cb.getStats().failures).toBe(0);

      // 3 more failures should not open circuit (counter was reset)
      for (let i = 0; i < 3; i++) {
        await expect(cb.execute(() => Promise.reject(new Error('fail')))).rejects.toThrow();
      }

      expect(cb.getStats().state).toBe('CLOSED');
    });
  });

  // ==========================================================================
  // CLOSED → OPEN transition
  // ==========================================================================
  describe('CLOSED → OPEN transition', () => {
    it('should open circuit after reaching failure threshold', async () => {
      const cb = new CircuitBreaker('test', { failureThreshold: 3 });

      for (let i = 0; i < 3; i++) {
        await expect(cb.execute(() => Promise.reject(new Error('fail')))).rejects.toThrow('fail');
      }

      expect(cb.getStats().state).toBe('OPEN');
    });

    it('should block requests when OPEN', async () => {
      const cb = new CircuitBreaker('test', { failureThreshold: 1, resetTimeoutMs: 30000 });

      await expect(cb.execute(() => Promise.reject(new Error('fail')))).rejects.toThrow('fail');

      await expect(cb.execute(() => Promise.resolve('should not run'))).rejects.toThrow(
        CircuitOpenError
      );
    });

    it('should include service name in CircuitOpenError', async () => {
      const cb = new CircuitBreaker('supabase', { failureThreshold: 1, resetTimeoutMs: 30000 });

      await expect(cb.execute(() => Promise.reject(new Error('fail')))).rejects.toThrow();

      try {
        await cb.execute(() => Promise.resolve('nope'));
      } catch (e) {
        expect(e).toBeInstanceOf(CircuitOpenError);
        expect((e as CircuitOpenError).serviceName).toBe('supabase');
        expect((e as CircuitOpenError).remainingMs).toBeGreaterThan(0);
        expect((e as CircuitOpenError).message).toContain('supabase');
      }
    });
  });

  // ==========================================================================
  // OPEN → HALF_OPEN transition
  // ==========================================================================
  describe('OPEN → HALF_OPEN transition', () => {
    it('should transition to HALF_OPEN after reset timeout', async () => {
      const cb = new CircuitBreaker('test', {
        failureThreshold: 1,
        resetTimeoutMs: 5000,
        successThreshold: 1,
      });

      // Open the circuit
      await expect(cb.execute(() => Promise.reject(new Error('fail')))).rejects.toThrow();
      expect(cb.getStats().state).toBe('OPEN');

      // Advance past reset timeout
      vi.advanceTimersByTime(5001);

      // Next call should go through (HALF_OPEN probe)
      const result = await cb.execute(() => Promise.resolve('recovered'));
      expect(result).toBe('recovered');
    });

    it('should still block before reset timeout expires', async () => {
      const cb = new CircuitBreaker('test', {
        failureThreshold: 1,
        resetTimeoutMs: 10000,
      });

      await expect(cb.execute(() => Promise.reject(new Error('fail')))).rejects.toThrow();

      // Only 5s elapsed, still within 10s timeout
      vi.advanceTimersByTime(5000);

      await expect(cb.execute(() => Promise.resolve('nope'))).rejects.toThrow(CircuitOpenError);
    });
  });

  // ==========================================================================
  // HALF_OPEN → CLOSED transition
  // ==========================================================================
  describe('HALF_OPEN → CLOSED transition', () => {
    it('should close circuit after enough successes in HALF_OPEN', async () => {
      const cb = new CircuitBreaker('test', {
        failureThreshold: 1,
        resetTimeoutMs: 1000,
        successThreshold: 2,
      });

      // Open
      await expect(cb.execute(() => Promise.reject(new Error('fail')))).rejects.toThrow();
      vi.advanceTimersByTime(1001);

      // 2 successes in HALF_OPEN
      await cb.execute(() => Promise.resolve('ok'));
      await cb.execute(() => Promise.resolve('ok'));

      expect(cb.getStats().state).toBe('CLOSED');
    });
  });

  // ==========================================================================
  // HALF_OPEN → OPEN (failure during probe)
  // ==========================================================================
  describe('HALF_OPEN → OPEN on failure', () => {
    it('should reopen circuit on failure during HALF_OPEN', async () => {
      const cb = new CircuitBreaker('test', {
        failureThreshold: 1,
        resetTimeoutMs: 1000,
        successThreshold: 3,
      });

      // Open
      await expect(cb.execute(() => Promise.reject(new Error('fail')))).rejects.toThrow();
      vi.advanceTimersByTime(1001);

      // Fail during HALF_OPEN probe
      await expect(cb.execute(() => Promise.reject(new Error('still broken')))).rejects.toThrow(
        'still broken'
      );

      expect(cb.getStats().state).toBe('OPEN');
    });
  });

  // ==========================================================================
  // Stats tracking
  // ==========================================================================
  describe('stats tracking', () => {
    it('should track total requests and failures', async () => {
      const cb = new CircuitBreaker('test', { failureThreshold: 10 });

      await cb.execute(() => Promise.resolve('ok'));
      await cb.execute(() => Promise.resolve('ok'));
      await expect(cb.execute(() => Promise.reject(new Error('fail')))).rejects.toThrow();

      const stats = cb.getStats();
      expect(stats.totalRequests).toBe(3);
      expect(stats.totalFailures).toBe(1);
    });

    it('should record last failure time', async () => {
      const cb = new CircuitBreaker('test', { failureThreshold: 10 });

      vi.setSystemTime(new Date('2026-01-28T10:00:00Z'));
      await expect(cb.execute(() => Promise.reject(new Error('fail')))).rejects.toThrow();

      expect(cb.getStats().lastFailureTime).toBe(new Date('2026-01-28T10:00:00Z').getTime());
    });
  });

  // ==========================================================================
  // Manual reset
  // ==========================================================================
  describe('manual reset', () => {
    it('should reset to CLOSED state', async () => {
      const cb = new CircuitBreaker('test', { failureThreshold: 1 });

      await expect(cb.execute(() => Promise.reject(new Error('fail')))).rejects.toThrow();
      expect(cb.getStats().state).toBe('OPEN');

      cb.reset();

      expect(cb.getStats().state).toBe('CLOSED');
      expect(cb.getStats().failures).toBe(0);
      expect(cb.getStats().lastFailureTime).toBeNull();
    });

    it('should allow requests after manual reset', async () => {
      const cb = new CircuitBreaker('test', { failureThreshold: 1, resetTimeoutMs: 60000 });

      await expect(cb.execute(() => Promise.reject(new Error('fail')))).rejects.toThrow();
      cb.reset();

      const result = await cb.execute(() => Promise.resolve('back to normal'));
      expect(result).toBe('back to normal');
    });
  });
});
