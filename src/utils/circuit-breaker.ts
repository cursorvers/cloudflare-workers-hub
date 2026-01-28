/**
 * Circuit Breaker for External Service Calls
 *
 * Prevents cascading failures by tracking error rates and
 * temporarily blocking requests to failing services.
 *
 * States: CLOSED (normal) → OPEN (blocking) → HALF_OPEN (probing)
 */

import { safeLog } from './log-sanitizer';

// ============================================================================
// Types
// ============================================================================

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerOptions {
  /** Number of failures before opening the circuit */
  failureThreshold: number;
  /** Time in ms before transitioning from OPEN to HALF_OPEN */
  resetTimeoutMs: number;
  /** Number of successful calls in HALF_OPEN to close the circuit */
  successThreshold: number;
}

export interface CircuitBreakerStats {
  state: CircuitState;
  failures: number;
  successes: number;
  lastFailureTime: number | null;
  totalRequests: number;
  totalFailures: number;
}

// ============================================================================
// Default Options
// ============================================================================

const DEFAULT_OPTIONS: CircuitBreakerOptions = {
  failureThreshold: 5,
  resetTimeoutMs: 30_000,
  successThreshold: 2,
};

// ============================================================================
// Circuit Breaker
// ============================================================================

export class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private failures = 0;
  private successes = 0;
  private lastFailureTime: number | null = null;
  private totalRequests = 0;
  private totalFailures = 0;
  private readonly options: CircuitBreakerOptions;
  private readonly name: string;

  constructor(name: string, options: Partial<CircuitBreakerOptions> = {}) {
    this.name = name;
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * Execute a function through the circuit breaker
   *
   * @param fn - The async function to execute
   * @returns The result of fn, or throws CircuitOpenError
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    this.totalRequests++;

    if (this.state === 'OPEN') {
      if (this.shouldAttemptReset()) {
        this.transitionTo('HALF_OPEN');
      } else {
        throw new CircuitOpenError(this.name, this.getRemainingTimeout());
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  /** Get current circuit breaker stats */
  getStats(): CircuitBreakerStats {
    return {
      state: this.state,
      failures: this.failures,
      successes: this.successes,
      lastFailureTime: this.lastFailureTime,
      totalRequests: this.totalRequests,
      totalFailures: this.totalFailures,
    };
  }

  /** Reset the circuit breaker to CLOSED state */
  reset(): void {
    this.transitionTo('CLOSED');
    this.failures = 0;
    this.successes = 0;
    this.lastFailureTime = null;
  }

  // --------------------------------------------------------------------------
  // Private
  // --------------------------------------------------------------------------

  private onSuccess(): void {
    if (this.state === 'HALF_OPEN') {
      this.successes++;
      if (this.successes >= this.options.successThreshold) {
        this.transitionTo('CLOSED');
        this.failures = 0;
        this.successes = 0;
      }
    } else {
      // Reset consecutive failure counter on success in CLOSED state
      this.failures = 0;
    }
  }

  private onFailure(): void {
    this.failures++;
    this.totalFailures++;
    this.lastFailureTime = Date.now();

    if (this.state === 'HALF_OPEN') {
      this.transitionTo('OPEN');
      this.successes = 0;
    } else if (this.failures >= this.options.failureThreshold) {
      this.transitionTo('OPEN');
    }
  }

  private shouldAttemptReset(): boolean {
    if (!this.lastFailureTime) return true;
    return Date.now() - this.lastFailureTime >= this.options.resetTimeoutMs;
  }

  private getRemainingTimeout(): number {
    if (!this.lastFailureTime) return 0;
    const elapsed = Date.now() - this.lastFailureTime;
    return Math.max(0, this.options.resetTimeoutMs - elapsed);
  }

  private transitionTo(newState: CircuitState): void {
    if (this.state !== newState) {
      safeLog.info(`[CircuitBreaker:${this.name}] ${this.state} → ${newState}`, {
        failures: this.failures,
        successes: this.successes,
      });
      this.state = newState;
    }
  }
}

// ============================================================================
// Error
// ============================================================================

export class CircuitOpenError extends Error {
  readonly remainingMs: number;
  readonly serviceName: string;

  constructor(serviceName: string, remainingMs: number) {
    super(`Circuit breaker OPEN for ${serviceName}, retry after ${Math.ceil(remainingMs / 1000)}s`);
    this.name = 'CircuitOpenError';
    this.serviceName = serviceName;
    this.remainingMs = remainingMs;
  }
}
