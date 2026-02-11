/**
 * KV-based Nonce Store & Rate Limiter for Autopilot
 *
 * - Nonce: prevents webhook replay attacks (5 min TTL)
 * - Rate limit: sliding-window counter per key (configurable window)
 * - Graceful degradation: returns allow if KV unavailable
 */

import type { Env } from '../../../types';
import { safeLog } from '../../../utils/log-sanitizer';

// =============================================================================
// Configuration
// =============================================================================

export interface NonceConfig {
  readonly ttlSeconds: number;
  readonly prefix: string;
}

export interface RateLimitConfig {
  readonly windowSeconds: number;
  readonly maxRequests: number;
  readonly prefix: string;
}

export const DEFAULT_NONCE_CONFIG: NonceConfig = Object.freeze({
  ttlSeconds: 300, // 5 minutes
  prefix: 'autopilot:nonce:',
});

export const DEFAULT_RATE_LIMIT_CONFIG: RateLimitConfig = Object.freeze({
  windowSeconds: 60, // 1 minute window
  maxRequests: 60,   // 60 requests per minute
  prefix: 'autopilot:rate:',
});

// =============================================================================
// Nonce Result Types
// =============================================================================

export interface NonceCheckResult {
  readonly valid: boolean;
  readonly reason: string;
}

export interface RateLimitResult {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly resetAtMs: number;
  readonly reason: string;
}

// =============================================================================
// Nonce Operations (Replay Prevention)
// =============================================================================

/**
 * Check and consume a nonce. Returns valid=true if nonce is fresh (first use).
 * Graceful degradation: returns valid=true if KV unavailable.
 */
export async function checkAndConsumeNonce(
  kv: KVNamespace | undefined,
  nonce: string,
  config: NonceConfig = DEFAULT_NONCE_CONFIG,
): Promise<NonceCheckResult> {
  if (!nonce || nonce.length === 0) {
    return Object.freeze({ valid: false, reason: 'nonce is empty' });
  }

  if (!kv) {
    safeLog.warn('[NonceRateLimit] KV not available, allowing nonce (degraded mode)');
    return Object.freeze({ valid: true, reason: 'kv_unavailable_degraded' });
  }

  const key = config.prefix + nonce;

  try {
    const existing = await kv.get(key);
    if (existing !== null) {
      return Object.freeze({ valid: false, reason: 'nonce already consumed' });
    }

    await kv.put(key, '1', { expirationTtl: config.ttlSeconds });
    return Object.freeze({ valid: true, reason: 'ok' });
  } catch (err) {
    safeLog.error('[NonceRateLimit] Nonce check failed (degraded mode)', {
      error: err instanceof Error ? err.message : String(err),
    });
    return Object.freeze({ valid: true, reason: 'kv_error_degraded' });
  }
}

// =============================================================================
// Rate Limiting (Sliding Window Counter)
// =============================================================================

/**
 * Check rate limit for a given key (IP, API key, etc.).
 * Uses KV with expiration for automatic cleanup.
 * Graceful degradation: returns allowed=true if KV unavailable.
 */
export async function checkRateLimit(
  kv: KVNamespace | undefined,
  key: string,
  config: RateLimitConfig = DEFAULT_RATE_LIMIT_CONFIG,
  nowMs: number = Date.now(),
): Promise<RateLimitResult> {
  if (!key || key.length === 0) {
    return Object.freeze({
      allowed: false,
      remaining: 0,
      resetAtMs: nowMs,
      reason: 'key is empty',
    });
  }

  if (!kv) {
    safeLog.warn('[NonceRateLimit] KV not available, allowing request (degraded mode)');
    return Object.freeze({
      allowed: true,
      remaining: config.maxRequests,
      resetAtMs: nowMs + config.windowSeconds * 1000,
      reason: 'kv_unavailable_degraded',
    });
  }

  const windowKey = config.prefix + key;
  const resetAtMs = nowMs + config.windowSeconds * 1000;

  try {
    const raw = await kv.get(windowKey);
    const current = raw ? parseInt(raw, 10) : 0;

    if (isNaN(current)) {
      // Corrupted value, reset
      await kv.put(windowKey, '1', { expirationTtl: config.windowSeconds });
      return Object.freeze({
        allowed: true,
        remaining: config.maxRequests - 1,
        resetAtMs,
        reason: 'ok',
      });
    }

    if (current >= config.maxRequests) {
      return Object.freeze({
        allowed: false,
        remaining: 0,
        resetAtMs,
        reason: 'rate limit exceeded',
      });
    }

    const next = current + 1;
    await kv.put(windowKey, String(next), { expirationTtl: config.windowSeconds });

    return Object.freeze({
      allowed: true,
      remaining: config.maxRequests - next,
      resetAtMs,
      reason: 'ok',
    });
  } catch (err) {
    safeLog.error('[NonceRateLimit] Rate limit check failed (degraded mode)', {
      error: err instanceof Error ? err.message : String(err),
    });
    return Object.freeze({
      allowed: true,
      remaining: config.maxRequests,
      resetAtMs,
      reason: 'kv_error_degraded',
    });
  }
}

// =============================================================================
// Combined Middleware Helper
// =============================================================================

export interface MiddlewareResult {
  readonly allowed: boolean;
  readonly nonceResult?: NonceCheckResult;
  readonly rateLimitResult?: RateLimitResult;
  readonly reason: string;
}

/**
 * Combined nonce + rate limit check for webhook requests.
 */
export async function checkWebhookMiddleware(
  kv: KVNamespace | undefined,
  nonce: string | undefined,
  rateLimitKey: string,
  nonceConfig?: NonceConfig,
  rateLimitConfig?: RateLimitConfig,
): Promise<MiddlewareResult> {
  // Rate limit check first (cheaper)
  const rateLimitResult = await checkRateLimit(kv, rateLimitKey, rateLimitConfig);
  if (!rateLimitResult.allowed) {
    return Object.freeze({
      allowed: false,
      rateLimitResult,
      reason: rateLimitResult.reason,
    });
  }

  // Nonce check (if provided)
  if (nonce) {
    const nonceResult = await checkAndConsumeNonce(kv, nonce, nonceConfig);
    if (!nonceResult.valid) {
      return Object.freeze({
        allowed: false,
        nonceResult,
        rateLimitResult,
        reason: nonceResult.reason,
      });
    }

    return Object.freeze({
      allowed: true,
      nonceResult,
      rateLimitResult,
      reason: 'ok',
    });
  }

  return Object.freeze({
    allowed: true,
    rateLimitResult,
    reason: 'ok',
  });
}
