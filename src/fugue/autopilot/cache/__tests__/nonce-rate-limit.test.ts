import { describe, expect, it, vi, beforeEach } from 'vitest';

import {
  checkAndConsumeNonce,
  checkRateLimit,
  checkWebhookMiddleware,
  DEFAULT_NONCE_CONFIG,
  DEFAULT_RATE_LIMIT_CONFIG,
} from '../nonce-rate-limit';

function createMockKV(): KVNamespace & { _store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    _store: store,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => { store.set(key, value); }),
    delete: vi.fn(async (key: string) => { store.delete(key); }),
    list: vi.fn(async () => ({ keys: [], list_complete: true, cacheStatus: null })),
    getWithMetadata: vi.fn(async () => ({ value: null, metadata: null, cacheStatus: null })),
  } as unknown as KVNamespace & { _store: Map<string, string> };
}

describe('fugue/autopilot/cache/nonce-rate-limit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // =========================================================================
  // Nonce
  // =========================================================================

  describe('checkAndConsumeNonce', () => {
    it('accepts fresh nonce', async () => {
      const kv = createMockKV();
      const result = await checkAndConsumeNonce(kv, 'nonce-123');

      expect(result.valid).toBe(true);
      expect(result.reason).toBe('ok');
      expect(kv._store.has(DEFAULT_NONCE_CONFIG.prefix + 'nonce-123')).toBe(true);
    });

    it('rejects replayed nonce', async () => {
      const kv = createMockKV();
      await checkAndConsumeNonce(kv, 'nonce-replay');
      const result = await checkAndConsumeNonce(kv, 'nonce-replay');

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('nonce already consumed');
    });

    it('rejects empty nonce', async () => {
      const kv = createMockKV();
      const result = await checkAndConsumeNonce(kv, '');

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('nonce is empty');
    });

    it('degrades gracefully when KV unavailable', async () => {
      const result = await checkAndConsumeNonce(undefined, 'nonce-123');

      expect(result.valid).toBe(true);
      expect(result.reason).toBe('kv_unavailable_degraded');
    });

    it('degrades on KV error', async () => {
      const kv = createMockKV();
      (kv.get as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('KV error'));
      const result = await checkAndConsumeNonce(kv, 'nonce-error');

      expect(result.valid).toBe(true);
      expect(result.reason).toBe('kv_error_degraded');
    });

    it('all results are frozen', async () => {
      const kv = createMockKV();
      const result = await checkAndConsumeNonce(kv, 'nonce-freeze');
      expect(Object.isFrozen(result)).toBe(true);
    });
  });

  // =========================================================================
  // Rate Limit
  // =========================================================================

  describe('checkRateLimit', () => {
    it('allows request within limit', async () => {
      const kv = createMockKV();
      const result = await checkRateLimit(kv, 'ip-1');

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(DEFAULT_RATE_LIMIT_CONFIG.maxRequests - 1);
    });

    it('denies when limit exceeded', async () => {
      const kv = createMockKV();
      const config = { ...DEFAULT_RATE_LIMIT_CONFIG, maxRequests: 3 };

      for (let i = 0; i < 3; i++) {
        await checkRateLimit(kv, 'ip-limit', config);
      }
      const result = await checkRateLimit(kv, 'ip-limit', config);

      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
      expect(result.reason).toBe('rate limit exceeded');
    });

    it('rejects empty key', async () => {
      const kv = createMockKV();
      const result = await checkRateLimit(kv, '');

      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('key is empty');
    });

    it('degrades when KV unavailable', async () => {
      const result = await checkRateLimit(undefined, 'ip-1');

      expect(result.allowed).toBe(true);
      expect(result.reason).toBe('kv_unavailable_degraded');
    });

    it('handles corrupted KV values', async () => {
      const kv = createMockKV();
      kv._store.set(DEFAULT_RATE_LIMIT_CONFIG.prefix + 'ip-corrupt', 'not-a-number');
      const result = await checkRateLimit(kv, 'ip-corrupt');

      expect(result.allowed).toBe(true);
      expect(result.reason).toBe('ok');
    });

    it('all results are frozen', async () => {
      const kv = createMockKV();
      const result = await checkRateLimit(kv, 'ip-freeze');
      expect(Object.isFrozen(result)).toBe(true);
    });
  });

  // =========================================================================
  // Combined Middleware
  // =========================================================================

  describe('checkWebhookMiddleware', () => {
    it('allows when both nonce and rate limit pass', async () => {
      const kv = createMockKV();
      const result = await checkWebhookMiddleware(kv, 'nonce-ok', 'ip-ok');

      expect(result.allowed).toBe(true);
      expect(result.reason).toBe('ok');
      expect(result.nonceResult?.valid).toBe(true);
      expect(result.rateLimitResult?.allowed).toBe(true);
    });

    it('blocks when rate limit exceeded (checked first)', async () => {
      const kv = createMockKV();
      const config = { ...DEFAULT_RATE_LIMIT_CONFIG, maxRequests: 0 };
      kv._store.set(config.prefix + 'ip-blocked', '0');

      const result = await checkWebhookMiddleware(kv, 'nonce-ok', 'ip-blocked', undefined, config);

      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('rate limit exceeded');
    });

    it('blocks when nonce is replayed', async () => {
      const kv = createMockKV();
      await checkWebhookMiddleware(kv, 'nonce-dup', 'ip-ok');
      const result = await checkWebhookMiddleware(kv, 'nonce-dup', 'ip-ok');

      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('nonce already consumed');
    });

    it('skips nonce check when nonce is undefined', async () => {
      const kv = createMockKV();
      const result = await checkWebhookMiddleware(kv, undefined, 'ip-ok');

      expect(result.allowed).toBe(true);
      expect(result.nonceResult).toBeUndefined();
    });

    it('all results are frozen', async () => {
      const kv = createMockKV();
      const result = await checkWebhookMiddleware(kv, 'nonce-freeze', 'ip-freeze');
      expect(Object.isFrozen(result)).toBe(true);
    });
  });
});
