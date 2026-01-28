/**
 * Tests for Rate Limiter
 *
 * Tests covering:
 * - KV-based sliding window rate limiting
 * - In-memory fallback rate limiting
 * - Channel-specific rate limit configs
 * - Rate limit response generation
 * - Rate limit header injection
 * - KV error fallback behavior
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { checkRateLimit, createRateLimitResponse, addRateLimitHeaders } from './rate-limiter';

// Helper: create mock KV namespace
function createMockKV(
  data: Record<string, unknown> = {},
  opts: { shouldFail?: boolean } = {}
) {
  return {
    get: vi.fn(async (key: string, type?: string) => {
      if (opts.shouldFail) throw new Error('KV unavailable');
      const value = data[key];
      if (type === 'json') return value ?? null;
      return value ? JSON.stringify(value) : null;
    }),
    put: vi.fn(async () => {
      if (opts.shouldFail) throw new Error('KV unavailable');
    }),
    delete: vi.fn(),
    list: vi.fn(),
  };
}

// Helper: create mock Env
function createEnv(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    AI: {},
    ENVIRONMENT: 'test',
    ...overrides,
  } as any;
}

describe('Rate Limiter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ==========================================================================
  // checkRateLimit - KV path
  // ==========================================================================
  describe('checkRateLimit (KV)', () => {
    it('should allow first request', async () => {
      const mockKV = createMockKV({});
      const env = createEnv({ CACHE: mockKV });

      const result = await checkRateLimit(env, 'slack', 'user-1');

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBeGreaterThan(0);
    });

    it('should track remaining requests', async () => {
      const now = Date.now();
      const existingRequests = Array.from({ length: 5 }, (_, i) => now - i * 100);
      const mockKV = createMockKV({
        'ratelimit:slack:user-1': { requests: existingRequests },
      });
      const env = createEnv({ CACHE: mockKV });

      const result = await checkRateLimit(env, 'slack', 'user-1');

      expect(result.allowed).toBe(true);
      // slack limit is 100 req/min, 5 existing + 1 new = 6 used
      expect(result.remaining).toBe(94);
    });

    it('should block when limit exceeded', async () => {
      const now = Date.now();
      // Fill up to 100 requests (slack limit)
      const existingRequests = Array.from({ length: 100 }, (_, i) => now - i * 500);
      const mockKV = createMockKV({
        'ratelimit:slack:user-1': { requests: existingRequests },
      });
      const env = createEnv({ CACHE: mockKV });

      const result = await checkRateLimit(env, 'slack', 'user-1');

      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
      expect(result.retryAfter).toBeGreaterThan(0);
    });

    it('should expire old requests outside window', async () => {
      const now = Date.now();
      // All requests are 2 minutes old (outside 1-minute window)
      const oldRequests = Array.from({ length: 100 }, () => now - 120000);
      const mockKV = createMockKV({
        'ratelimit:slack:user-1': { requests: oldRequests },
      });
      const env = createEnv({ CACHE: mockKV });

      const result = await checkRateLimit(env, 'slack', 'user-1');

      expect(result.allowed).toBe(true);
    });

    it('should store updated requests to KV', async () => {
      const mockKV = createMockKV({});
      const env = createEnv({ CACHE: mockKV });

      await checkRateLimit(env, 'slack', 'user-1');

      expect(mockKV.put).toHaveBeenCalledWith(
        'ratelimit:slack:user-1',
        expect.any(String),
        expect.objectContaining({ expirationTtl: expect.any(Number) })
      );
    });

    it('should use channel-specific limits', async () => {
      const now = Date.now();
      // 15 requests - under slack (100) but over admin (10)
      const requests = Array.from({ length: 15 }, (_, i) => now - i * 100);

      const mockKV = createMockKV({
        'ratelimit:admin:admin-1': { requests },
      });
      const env = createEnv({ CACHE: mockKV });

      const result = await checkRateLimit(env, 'admin', 'admin-1');

      expect(result.allowed).toBe(false);
    });

    it('should use default limit for unknown channels', async () => {
      const now = Date.now();
      // 35 requests - over default limit (30)
      const requests = Array.from({ length: 35 }, (_, i) => now - i * 100);
      const mockKV = createMockKV({
        'ratelimit:custom-channel:user-1': { requests },
      });
      const env = createEnv({ CACHE: mockKV });

      const result = await checkRateLimit(env, 'custom-channel', 'user-1');

      expect(result.allowed).toBe(false);
    });
  });

  // ==========================================================================
  // checkRateLimit - In-memory fallback
  // ==========================================================================
  describe('checkRateLimit (in-memory)', () => {
    it('should allow first request without KV', async () => {
      const env = createEnv({});

      const result = await checkRateLimit(env, 'slack', 'user-1');

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(99); // 100 - 1
    });

    it('should fall back to in-memory when KV fails', async () => {
      const mockKV = createMockKV({}, { shouldFail: true });
      const env = createEnv({ CACHE: mockKV });

      const result = await checkRateLimit(env, 'slack', 'user-1');

      expect(result.allowed).toBe(true);
    });

    it('should track requests in memory across calls', async () => {
      const env = createEnv({});

      // Make multiple requests
      for (let i = 0; i < 29; i++) {
        await checkRateLimit(env, 'default-channel', `user-mem-test`);
      }

      const result = await checkRateLimit(env, 'default-channel', `user-mem-test`);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(0); // 30th of 30

      // 31st should be blocked
      const blocked = await checkRateLimit(env, 'default-channel', `user-mem-test`);
      expect(blocked.allowed).toBe(false);
    });
  });

  // ==========================================================================
  // createRateLimitResponse
  // ==========================================================================
  describe('createRateLimitResponse', () => {
    it('should return 429 status', () => {
      const response = createRateLimitResponse({
        allowed: false,
        remaining: 0,
        resetAt: Date.now() + 60000,
        retryAfter: 30,
      });

      expect(response.status).toBe(429);
    });

    it('should include Retry-After header', () => {
      const response = createRateLimitResponse({
        allowed: false,
        remaining: 0,
        resetAt: Date.now() + 60000,
        retryAfter: 30,
      });

      expect(response.headers.get('Retry-After')).toBe('30');
    });

    it('should include rate limit headers', () => {
      const resetAt = Date.now() + 60000;
      const response = createRateLimitResponse({
        allowed: false,
        remaining: 0,
        resetAt,
        retryAfter: 30,
      });

      expect(response.headers.get('X-RateLimit-Remaining')).toBe('0');
      expect(response.headers.get('X-RateLimit-Reset')).toBeDefined();
    });

    it('should return JSON body with error details', async () => {
      const response = createRateLimitResponse({
        allowed: false,
        remaining: 0,
        resetAt: Date.now() + 60000,
        retryAfter: 15,
      });

      const body = await response.json() as Record<string, unknown>;
      expect(body.error).toBe('Too Many Requests');
      expect(body.retryAfter).toBe(15);
      expect(body.resetAt).toBeDefined();
    });

    it('should include Content-Type application/json', () => {
      const response = createRateLimitResponse({
        allowed: false,
        remaining: 0,
        resetAt: Date.now() + 60000,
        retryAfter: 30,
      });

      expect(response.headers.get('Content-Type')).toBe('application/json');
    });
  });

  // ==========================================================================
  // addRateLimitHeaders
  // ==========================================================================
  describe('addRateLimitHeaders', () => {
    it('should add X-RateLimit-Remaining header', () => {
      const original = new Response('OK', { status: 200 });
      const result = addRateLimitHeaders(original, {
        allowed: true,
        remaining: 95,
        resetAt: Date.now() + 60000,
      });

      expect(result.headers.get('X-RateLimit-Remaining')).toBe('95');
    });

    it('should add X-RateLimit-Reset header', () => {
      const resetAt = Date.now() + 60000;
      const original = new Response('OK', { status: 200 });
      const result = addRateLimitHeaders(original, {
        allowed: true,
        remaining: 95,
        resetAt,
      });

      expect(result.headers.get('X-RateLimit-Reset')).toBe(
        String(Math.ceil(resetAt / 1000))
      );
    });

    it('should preserve original response status', () => {
      const original = new Response('Created', { status: 201 });
      const result = addRateLimitHeaders(original, {
        allowed: true,
        remaining: 99,
        resetAt: Date.now() + 60000,
      });

      expect(result.status).toBe(201);
    });

    it('should preserve original response body', async () => {
      const original = new Response('test body', { status: 200 });
      const result = addRateLimitHeaders(original, {
        allowed: true,
        remaining: 99,
        resetAt: Date.now() + 60000,
      });

      expect(await result.text()).toBe('test body');
    });

    it('should preserve original response headers', () => {
      const original = new Response('OK', {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'X-Custom': 'test' },
      });
      const result = addRateLimitHeaders(original, {
        allowed: true,
        remaining: 99,
        resetAt: Date.now() + 60000,
      });

      expect(result.headers.get('Content-Type')).toBe('application/json');
      expect(result.headers.get('X-Custom')).toBe('test');
    });
  });
});
