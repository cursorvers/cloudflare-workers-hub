/**
 * Rate Limiter (DO-first, KV fallback)
 *
 * Implements token bucket algorithm for rate limiting API requests.
 * Uses a Durable Object on hot paths to avoid KV daily write quota blowups.
 * Falls back to KV or in-memory tracking when DO is not available (tests/dev).
 *
 * ## Features
 * - Sliding window algorithm (1-minute buckets)
 * - Per-IP and per-user rate limiting
 * - Configurable limits per endpoint
 * - Automatic cleanup of expired keys
 * - DDoS mitigation
 *
 * ## Configuration
 * Rate limits are defined per endpoint pattern:
 * - /api/cockpit/tasks: 60 req/min (user), 30 req/min (IP)
 * - /api/queue: 120 req/min (user), 60 req/min (IP)
 * - Default: 100 req/min (user), 50 req/min (IP)
 */

import type { Env } from '../types';
import { safeLog } from './log-sanitizer';

// =============================================================================
// Types
// =============================================================================

export interface RateLimitConfig {
  maxRequestsPerMinute: number;
  keyPrefix: string;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  // Historically some callsites/tests used epoch millis. Keep both for compatibility.
  resetAt: Date | number;
  retryAfter?: number; // seconds
}

// =============================================================================
// Rate Limit Configuration
// =============================================================================

// Legacy (channel-based) limits used by older code + tests.
const LEGACY_CHANNEL_LIMITS: Record<string, number> = {
  slack: 100,
  admin: 10,
  // Webhook policies
  limitless_webhook_public: 10,
  limitless_webhook_auth: 60,
  default: 30,
};

const RATE_LIMITS: Record<string, { user: number; ip: number }> = {
  // High-frequency endpoints
  '/api/queue': { user: 120, ip: 60 },
  '/api/result': { user: 120, ip: 60 },

  // Medium-frequency endpoints
  '/api/cockpit/tasks': { user: 60, ip: 30 },
  '/api/cockpit/repos': { user: 60, ip: 30 },
  '/api/cockpit/alerts': { user: 60, ip: 30 },

  // Low-frequency endpoints
  '/api/memory': { user: 30, ip: 15 },
  '/api/admin': { user: 10, ip: 5 },

  // Default for unlisted endpoints
  default: { user: 100, ip: 50 },
};

// =============================================================================
// Rate Limiter Implementation
// =============================================================================

/**
 * Get rate limit configuration for an endpoint
 */
function getRateLimitConfig(pathname: string): { user: number; ip: number } {
  // Find matching endpoint pattern
  for (const [pattern, limits] of Object.entries(RATE_LIMITS)) {
    if (pattern !== 'default' && pathname.startsWith(pattern)) {
      return limits;
    }
  }
  return RATE_LIMITS.default;
}

/**
 * Extract client identifier from request
 *
 * Priority:
 * 1. Authenticated user ID (most specific)
 * 2. IP address (fallback for anonymous requests)
 * 3. Cloudflare ray ID (last resort)
 */
function getClientIdentifier(request: Request, userId?: string): string {
  if (userId) {
    return `user:${userId}`;
  }

  // Get IP from Cloudflare headers
  const cfConnectingIp = request.headers.get('CF-Connecting-IP');
  if (cfConnectingIp) {
    return `ip:${cfConnectingIp}`;
  }

  // Fallback to ray ID (unique per request, not ideal for rate limiting)
  const rayId = request.headers.get('CF-RAY');
  if (rayId) {
    return `ray:${rayId}`;
  }

  return 'unknown';
}

/**
 * Get current time window (1-minute buckets)
 */
function getCurrentWindow(): string {
  const now = Math.floor(Date.now() / 1000); // Unix timestamp
  const windowStart = Math.floor(now / 60) * 60; // Round down to minute
  return windowStart.toString();
}

/**
 * Check rate limit for a request
 *
 * Uses sliding window algorithm with 1-minute buckets.
 * Stores request count in KV with automatic expiration.
 */
async function checkHttpRateLimit(
  request: Request,
  env: Env,
  userId?: string
): Promise<RateLimitResult> {
  // In Workers, request.url is absolute. In tests it may be relative.
  const pathname = new URL(request.url, 'http://localhost').pathname;
  const config = getRateLimitConfig(pathname);
  const clientId = getClientIdentifier(request, userId);
  const isUser = clientId.startsWith('user:');
  const maxRequests = isUser ? config.user : config.ip;

  // Generate KV key: ratelimit:<client>:<endpoint>:<window>
  const window = getCurrentWindow();
  const key = `ratelimit:${clientId}:${pathname}:${window}`;

  try {
    const windowStartSec = parseInt(window, 10);
    const resetAt = new Date((windowStartSec + 60) * 1000);

    // Prefer DO to avoid KV puts on every request.
    if (env.RATE_LIMITER) {
      // Stable sharding: keep DO instance count bounded.
      const shard = fnv1a32(clientId) & 255; // 256 shards
      const id = env.RATE_LIMITER.idFromName(`rl:${shard}`);
      const stub = env.RATE_LIMITER.get(id);
      const resp = await stub.fetch('https://rate-limiter/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key,
          limit: maxRequests,
          ttlSec: 120, // window + grace period
          windowStartSec,
          windowSec: 60,
        }),
      });

      const data = (await resp.json()) as { allowed: boolean; remaining: number; retryAfter?: number };
      if (!data.allowed) {
        const retryAfter = Number.isFinite(data.retryAfter) ? data.retryAfter : Math.ceil((resetAt.getTime() - Date.now()) / 1000);
        safeLog.warn('[RateLimit] Limit exceeded', { clientId, pathname, current: maxRequests, maxRequests, retryAfter });
        return { allowed: false, remaining: 0, resetAt, retryAfter };
      }

      return { allowed: true, remaining: Math.max(0, data.remaining ?? 0), resetAt };
    }

    // Fallback: per-isolate memory bucket counter (best-effort).
    const store = getHttpBuckets(env);
    const nowMs = Date.now();
    const expiresAtMs = nowMs + 120_000;
    const existing = store.get(key);
    const fresh = existing && existing.expiresAtMs > nowMs ? existing : null;
    const current = fresh?.count ?? 0;

    if (current >= maxRequests) {
      const retryAfter = Math.ceil((resetAt.getTime() - nowMs) / 1000);
      safeLog.warn('[RateLimit] Limit exceeded (memory fallback)', { clientId, pathname, current, maxRequests, retryAfter });
      return { allowed: false, remaining: 0, resetAt, retryAfter };
    }

    const newCount = current + 1;
    store.set(key, { count: newCount, expiresAtMs });
    return { allowed: true, remaining: maxRequests - newCount, resetAt };
  } catch (error) {
    // If KV is unavailable, fail open (allow request) to prevent service disruption
    safeLog.error('[RateLimit] KV error, failing open', { error });
      return {
        allowed: true,
        remaining: maxRequests,
        resetAt: new Date(Date.now() + 60000),
      };
    }
}

function fnv1a32(input: string): number {
  // 32-bit FNV-1a
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

type HttpBucket = { count: number; expiresAtMs: number };
const httpBucketsByEnv = new WeakMap<Env, Map<string, HttpBucket>>();

function getHttpBuckets(env: Env): Map<string, HttpBucket> {
  let store = httpBucketsByEnv.get(env);
  if (!store) {
    store = new Map();
    httpBucketsByEnv.set(env, store);
  }
  return store;
}

const memoryByEnv = new WeakMap<Env, Map<string, number[]>>();

function getLegacyLimit(channel: string): number {
  return LEGACY_CHANNEL_LIMITS[channel] ?? LEGACY_CHANNEL_LIMITS.default;
}

async function checkLegacyRateLimit(
  env: Env,
  channel: string,
  userId: string
): Promise<RateLimitResult> {
  const limit = getLegacyLimit(channel);
  const key = `ratelimit:${channel}:${userId}`;
  const now = Date.now();
  const cutoff = now - 60_000;

  const inMemoryCheck = async (): Promise<RateLimitResult> => {
    let store = memoryByEnv.get(env);
    if (!store) {
      store = new Map();
      memoryByEnv.set(env, store);
    }

    const requests = store.get(key) ?? [];
    const recent = requests.filter((ts) => ts >= cutoff);

    if (recent.length >= limit) {
      const oldest = Math.min(...recent);
      const resetAt = oldest + 60_000;
      const retryAfter = Math.max(1, Math.ceil((resetAt - now) / 1000));
      store.set(key, recent);
      return { allowed: false, remaining: 0, resetAt, retryAfter };
    }

    const updated = [...recent, now];
    store.set(key, updated);
    return { allowed: true, remaining: limit - updated.length, resetAt: now + 60_000 };
  };

  // Prefer KV if available in this environment (legacy name: CACHE).
  try {
    const cache = (env as any).CACHE;
    if (!cache?.get || !cache?.put) return await inMemoryCheck();

    const stored = await cache.get(key, 'json');
    const existingRequests = Array.isArray(stored?.requests) ? stored.requests : [];
    const recent = existingRequests
      .filter((ts: unknown): ts is number => typeof ts === 'number' && ts >= cutoff);

    if (recent.length >= limit) {
      const oldest = Math.min(...recent);
      const resetAt = oldest + 60_000;
      const retryAfter = Math.max(1, Math.ceil((resetAt - now) / 1000));
      return { allowed: false, remaining: 0, resetAt, retryAfter };
    }

    const updated = [...recent, now];
    await cache.put(key, JSON.stringify({ requests: updated }), { expirationTtl: 120 });
    return { allowed: true, remaining: limit - updated.length, resetAt: now + 60_000 };
  } catch {
    // If KV is unavailable, fail open-ish: allow but keep some local tracking to avoid a hard bypass.
    return await inMemoryCheck();
  }
}

export async function checkRateLimit(
  request: Request,
  env: Env,
  userId?: string
): Promise<RateLimitResult>;
export async function checkRateLimit(
  env: Env,
  channel: string,
  userId: string
): Promise<RateLimitResult>;
export async function checkRateLimit(
  requestOrEnv: Request | Env,
  envOrChannel: Env | string,
  userId?: string
): Promise<RateLimitResult> {
  if (requestOrEnv instanceof Request) {
    return await checkHttpRateLimit(requestOrEnv, envOrChannel as Env, userId);
  }
  return await checkLegacyRateLimit(requestOrEnv, envOrChannel as string, userId ?? 'unknown');
}

/**
 * Create rate limit error response
 */
export function createRateLimitErrorResponse(result: RateLimitResult): Response {
  const resetAt = result.resetAt instanceof Date
    ? result.resetAt
    : new Date((result.resetAt as number) || Date.now());
  const resetAtSeconds = String(Math.ceil(resetAt.getTime() / 1000));

  return new Response(
    JSON.stringify({
      error: 'Too Many Requests',
      message: 'Too many requests. Please try again later.',
      retryAfter: result.retryAfter,
      resetAt: resetAtSeconds,
    }),
    {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'X-RateLimit-Remaining': result.remaining.toString(),
        // Epoch seconds (common convention for rate limit reset time).
        'X-RateLimit-Reset': resetAtSeconds,
        'Retry-After': (result.retryAfter || 60).toString(),
        'X-Content-Type-Options': 'nosniff',
      },
    }
  );
}

/**
 * Add rate limit headers to successful response
 */
export function addRateLimitHeaders(
  response: Response,
  result: RateLimitResult
): Response {
  const newResponse = new Response(response.body, response);
  newResponse.headers.set('X-RateLimit-Remaining', result.remaining.toString());
  const resetAt = result.resetAt instanceof Date
    ? result.resetAt
    : new Date((result.resetAt as number) || Date.now());
  newResponse.headers.set('X-RateLimit-Reset', String(Math.ceil(resetAt.getTime() / 1000)));
  return newResponse;
}

/**
 * Alias for backward compatibility
 * @deprecated Use createRateLimitErrorResponse instead
 */
export const createRateLimitResponse = createRateLimitErrorResponse;
