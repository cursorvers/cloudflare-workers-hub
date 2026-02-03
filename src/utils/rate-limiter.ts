/**
 * Rate Limiter with KV Storage
 *
 * Implements token bucket algorithm for rate limiting API requests.
 * Uses Cloudflare KV for distributed rate limiting across workers.
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
  resetAt: Date;
  retryAfter?: number; // seconds
}

// =============================================================================
// Rate Limit Configuration
// =============================================================================

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
export async function checkRateLimit(
  request: Request,
  env: Env,
  userId?: string
): Promise<RateLimitResult> {
  const pathname = new URL(request.url).pathname;
  const config = getRateLimitConfig(pathname);
  const clientId = getClientIdentifier(request, userId);
  const isUser = clientId.startsWith('user:');
  const maxRequests = isUser ? config.user : config.ip;

  // Generate KV key: ratelimit:<client>:<endpoint>:<window>
  const window = getCurrentWindow();
  const key = `ratelimit:${clientId}:${pathname}:${window}`;

  try {
    // Get current count
    const currentStr = await env.KV?.get(key);
    const current = currentStr ? parseInt(currentStr, 10) : 0;

    // Check if limit exceeded
    if (current >= maxRequests) {
      const resetAt = new Date((parseInt(window, 10) + 60) * 1000);
      const retryAfter = Math.ceil((resetAt.getTime() - Date.now()) / 1000);

      safeLog.warn('[RateLimit] Limit exceeded', {
        clientId,
        pathname,
        current,
        maxRequests,
        retryAfter,
      });

      return {
        allowed: false,
        remaining: 0,
        resetAt,
        retryAfter,
      };
    }

    // Increment counter
    const newCount = current + 1;
    await env.KV?.put(key, newCount.toString(), {
      expirationTtl: 120, // 2 minutes (window + grace period)
    });

    const resetAt = new Date((parseInt(window, 10) + 60) * 1000);
    return {
      allowed: true,
      remaining: maxRequests - newCount,
      resetAt,
    };
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

/**
 * Create rate limit error response
 */
export function createRateLimitErrorResponse(result: RateLimitResult): Response {
  return new Response(
    JSON.stringify({
      error: 'Rate limit exceeded',
      message: 'Too many requests. Please try again later.',
      retryAfter: result.retryAfter,
    }),
    {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'X-RateLimit-Remaining': result.remaining.toString(),
        'X-RateLimit-Reset': result.resetAt.toISOString(),
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
  newResponse.headers.set('X-RateLimit-Reset', result.resetAt.toISOString());
  return newResponse;
}
