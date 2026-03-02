/**
 * Durable Object Fetch Wrapper
 *
 * Combines CircuitBreaker + timeout + optional retry for DO stub.fetch calls.
 * - Circuit breaker is per DO class/route (not global)
 * - Retry only for idempotent operations (GET, or explicit opt-in)
 * - Timeout via AbortController
 * - Logs sanitized (no auth headers/body)
 */

import { CircuitBreaker, CircuitOpenError } from './circuit-breaker';
import { safeLog } from './log-sanitizer';
import { addBreadcrumb } from './sentry';

// ============================================================================
// Types
// ============================================================================

export interface DOFetchOptions {
  /** Timeout in ms (default: 5000) */
  timeoutMs?: number;
  /** Retry count for idempotent operations (default: 0 = no retry) */
  retries?: number;
  /** Initial retry delay in ms (default: 500) */
  retryDelayMs?: number;
  /** Circuit breaker name override (default: auto from DO class) */
  circuitName?: string;
}

// ============================================================================
// Circuit Breaker Registry (per DO class/route)
// ============================================================================

const circuitBreakers = new Map<string, CircuitBreaker>();

function getCircuitBreaker(name: string): CircuitBreaker {
  const existing = circuitBreakers.get(name);
  if (existing) return existing;

  const cb = new CircuitBreaker(name, {
    failureThreshold: 5,
    resetTimeoutMs: 30_000,
    successThreshold: 2,
  });
  circuitBreakers.set(name, cb);
  return cb;
}

/** Get all circuit breaker stats (for /metrics endpoint) */
export function getCircuitBreakerStats(): Record<string, { state: string; failures: number; totalRequests: number }> {
  const stats: Record<string, { state: string; failures: number; totalRequests: number }> = {};
  for (const [name, cb] of circuitBreakers) {
    const s = cb.getStats();
    stats[name] = { state: s.state, failures: s.failures, totalRequests: s.totalRequests };
  }
  return stats;
}

// ============================================================================
// Core: doFetch
// ============================================================================

/**
 * Fetch a Durable Object with circuit breaker, timeout, and optional retry.
 *
 * @example
 * ```ts
 * const stub = env.COCKPIT_WS.get(env.COCKPIT_WS.idFromName('cockpit'));
 * const res = await doFetch(stub, 'https://do/status', {
 *   method: 'GET',
 * }, { timeoutMs: 3000, retries: 1, circuitName: 'cockpit:status' });
 * ```
 */
export async function doFetch(
  stub: { fetch: (input: RequestInfo, init?: RequestInit) => Promise<Response> },
  input: RequestInfo,
  init?: RequestInit,
  options: DOFetchOptions = {},
): Promise<Response> {
  const {
    timeoutMs = 5_000,
    retries = 0,
    retryDelayMs = 500,
    circuitName,
  } = options;

  const url = typeof input === 'string' ? input : input.url;
  const cbName = circuitName ?? deriveCBName(url);
  const cb = getCircuitBreaker(cbName);

  // C-3: Guard against retrying non-idempotent operations
  const method = (
    init?.method ?? (input instanceof Request ? input.method : 'GET')
  ).toUpperCase();
  const effectiveRetries = retries > 0 && method !== 'GET' && method !== 'HEAD'
    ? 0 // Non-idempotent: silently disable retries to prevent duplicate writes
    : retries;

  if (retries > 0 && effectiveRetries === 0) {
    safeLog.warn(`[doFetch] Retries disabled for non-idempotent ${method} ${sanitizeUrl(url)}`);
  }

  let lastError: Error | undefined;
  let lastResponse: Response | undefined;

  for (let attempt = 0; attempt <= effectiveRetries; attempt++) {
    try {
      const response = await cb.execute(() => fetchWithTimeout(stub, input, init, timeoutMs));

      // C-1: Track 5xx as circuit breaker failure (undo the success recorded by execute)
      if (response.status >= 500) {
        cb.recordFailure();
        addBreadcrumb('do-fetch', `DO ${cbName} returned ${response.status}`, {
          url: sanitizeUrl(url),
          status: response.status,
          attempt,
        });
        lastResponse = response;
        lastError = new Error(`DO ${cbName} returned ${response.status}`);

        // Retry 5xx for idempotent operations
        if (attempt < effectiveRetries) {
          const jitter = Math.random() * 0.3 * retryDelayMs;
          const delay = Math.min(retryDelayMs * Math.pow(2, attempt) + jitter, 10_000);
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
        // Last attempt — return the 5xx response (caller decides)
        return response;
      }

      return response;
    } catch (error) {
      lastError = error as Error;

      if (error instanceof CircuitOpenError) {
        addBreadcrumb('do-fetch', `Circuit OPEN for ${cbName}`, {
          remainingMs: error.remainingMs,
        });
        throw error; // Don't retry when circuit is open
      }

      safeLog.warn(`[doFetch] ${cbName} attempt ${attempt + 1}/${effectiveRetries + 1} failed`, {
        error: (error as Error).message,
        url: sanitizeUrl(url),
      });

      if (attempt < effectiveRetries) {
        const jitter = Math.random() * 0.3 * retryDelayMs;
        const delay = Math.min(retryDelayMs * Math.pow(2, attempt) + jitter, 10_000);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  // Return last 5xx response if available, otherwise throw
  if (lastResponse) return lastResponse;
  throw lastError!;
}

// ============================================================================
// Helpers
// ============================================================================

async function fetchWithTimeout(
  stub: { fetch: (input: RequestInfo, init?: RequestInit) => Promise<Response> },
  input: RequestInfo,
  init: RequestInit | undefined,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const mergedInit: RequestInit = {
      ...init,
      signal: controller.signal,
    };
    return await stub.fetch(input, mergedInit);
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      throw new DOTimeoutError(timeoutMs);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** Derive circuit breaker name from DO URL: "https://do/start" → "do:start" */
function deriveCBName(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/^\/+/, '').replace(/\/+/g, ':');
    return `${parsed.hostname}:${path}` || 'do:unknown';
  } catch {
    return 'do:unknown';
  }
}

/** Strip query params and auth tokens from URL for logging */
function sanitizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.search = '';
    return parsed.toString();
  } catch {
    return '[invalid-url]';
  }
}

// ============================================================================
// Errors
// ============================================================================

export class DOTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`DO fetch timed out after ${timeoutMs}ms`);
    this.name = 'DOTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

export { CircuitOpenError };
