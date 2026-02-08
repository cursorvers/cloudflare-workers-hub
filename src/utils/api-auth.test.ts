/**
 * Tests for API Authentication Utilities
 *
 * Security-critical tests covering:
 * - Constant-time API key verification
 * - SHA-256 key hashing
 * - User ID extraction from KV mapping
 * - IDOR prevention via authorization checks
 * - Service role bypass for system daemons
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { verifyAPIKey, hashAPIKey, extractUserIdFromKey, authorizeUserAccess } from './api-auth';

// Mock log-sanitizer
vi.mock('./log-sanitizer', () => ({
  safeLog: {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  maskUserId: (id: string) => `${id.substring(0, 3)}***`,
}));

// Helper: create mock Request with optional headers
function createRequest(headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/test', {
    method: 'GET',
    headers: new Headers(headers),
  });
}

// Helper: create mock Env
function createEnv(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    AI: {},
    ENVIRONMENT: 'test',
    ...overrides,
  } as any;
}

// Helper: create mock KV namespace
function createMockKV(data: Record<string, unknown> = {}) {
  return {
    get: vi.fn(async (key: string, type?: string) => {
      const value = data[key];
      if (type === 'json') return value ?? null;
      return value ? JSON.stringify(value) : null;
    }),
    put: vi.fn(),
    delete: vi.fn(),
    list: vi.fn(),
  };
}

describe('API Authentication', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ==========================================================================
  // verifyAPIKey
  // ==========================================================================
  describe('verifyAPIKey', () => {
    it('should accept valid queue API key', () => {
      const apiKey = 'test-queue-api-key-12345';
      const env = createEnv({ QUEUE_API_KEY: apiKey });
      const request = createRequest({ 'X-API-Key': apiKey });

      expect(verifyAPIKey(request, env, 'queue')).toBe(true);
    });

    it('should accept valid memory API key', () => {
      const apiKey = 'test-memory-api-key-12345';
      const env = createEnv({ MEMORY_API_KEY: apiKey });
      const request = createRequest({ 'X-API-Key': apiKey });

      expect(verifyAPIKey(request, env, 'memory')).toBe(true);
    });

    it('should accept valid admin API key', () => {
      const apiKey = 'test-admin-api-key-12345';
      const env = createEnv({ ADMIN_API_KEY: apiKey });
      const request = createRequest({ 'X-API-Key': apiKey });

      expect(verifyAPIKey(request, env, 'admin')).toBe(true);
    });

    it('should fall back to ASSISTANT_API_KEY for queue scope', () => {
      const apiKey = 'legacy-assistant-key';
      const env = createEnv({ ASSISTANT_API_KEY: apiKey });
      const request = createRequest({ 'X-API-Key': apiKey });

      expect(verifyAPIKey(request, env, 'queue')).toBe(true);
    });

    it('should fall back to ASSISTANT_API_KEY for memory scope', () => {
      const apiKey = 'legacy-assistant-key';
      const env = createEnv({ ASSISTANT_API_KEY: apiKey });
      const request = createRequest({ 'X-API-Key': apiKey });

      expect(verifyAPIKey(request, env, 'memory')).toBe(true);
    });

    it('should NOT fall back to ASSISTANT_API_KEY for admin scope', () => {
      const env = createEnv({ ASSISTANT_API_KEY: 'legacy-key' });
      const request = createRequest({ 'X-API-Key': 'legacy-key' });

      expect(verifyAPIKey(request, env, 'admin')).toBe(false);
    });

    it('should reject when no API key configured (fail-closed)', () => {
      const env = createEnv({});
      const request = createRequest({ 'X-API-Key': 'any-key' });

      expect(verifyAPIKey(request, env, 'queue')).toBe(false);
    });

    it('should reject when no API key in request header', () => {
      const env = createEnv({ QUEUE_API_KEY: 'valid-key' });
      const request = createRequest({});

      expect(verifyAPIKey(request, env, 'queue')).toBe(false);
    });

    it('should reject wrong API key', () => {
      const env = createEnv({ QUEUE_API_KEY: 'correct-key' });
      const request = createRequest({ 'X-API-Key': 'wrong-key' });

      expect(verifyAPIKey(request, env, 'queue')).toBe(false);
    });

    it('should reject key with different length', () => {
      const env = createEnv({ QUEUE_API_KEY: 'short' });
      const request = createRequest({ 'X-API-Key': 'much-longer-key-value' });

      expect(verifyAPIKey(request, env, 'queue')).toBe(false);
    });

    it('should default to queue scope when no scope specified', () => {
      const apiKey = 'test-queue-key';
      const env = createEnv({ QUEUE_API_KEY: apiKey });
      const request = createRequest({ 'X-API-Key': apiKey });

      expect(verifyAPIKey(request, env)).toBe(true);
    });

    it('should use scoped key over legacy key when both exist', () => {
      const scopedKey = 'scoped-queue-key';
      const legacyKey = 'legacy-assistant-key';
      const env = createEnv({
        QUEUE_API_KEY: scopedKey,
        ASSISTANT_API_KEY: legacyKey,
      });

      const requestWithScoped = createRequest({ 'X-API-Key': scopedKey });
      expect(verifyAPIKey(requestWithScoped, env, 'queue')).toBe(true);

      const requestWithLegacy = createRequest({ 'X-API-Key': legacyKey });
      expect(verifyAPIKey(requestWithLegacy, env, 'queue')).toBe(false);
    });

    it('should reject empty API key in header', () => {
      const env = createEnv({ QUEUE_API_KEY: 'valid-key' });
      const request = createRequest({ 'X-API-Key': '' });

      expect(verifyAPIKey(request, env, 'queue')).toBe(false);
    });

    // ========================================================================
    // New scopes: highlight, limitless, monitoring
    // ========================================================================

    describe('highlight scope', () => {
      it('should accept HIGHLIGHT_API_KEY via X-API-Key header', () => {
        const key = 'highlight-key-abc';
        const env = createEnv({ HIGHLIGHT_API_KEY: key });
        const request = createRequest({ 'X-API-Key': key });

        expect(verifyAPIKey(request, env, 'highlight')).toBe(true);
      });

      it('should accept HIGHLIGHT_API_KEY via query param (iOS Shortcut)', () => {
        const key = 'highlight-key-abc';
        const env = createEnv({ HIGHLIGHT_API_KEY: key });
        const request = new Request(`http://localhost/api/highlight?apiKey=${key}`);

        expect(verifyAPIKey(request, env, 'highlight')).toBe(true);
      });

      it('should reject wrong key via query param', () => {
        const env = createEnv({ HIGHLIGHT_API_KEY: 'correct-key' });
        const request = new Request('http://localhost/api/highlight?apiKey=wrong-key');

        expect(verifyAPIKey(request, env, 'highlight')).toBe(false);
      });

      it('should accept WORKERS_API_KEY as super key', () => {
        const superKey = 'workers-super-key';
        const env = createEnv({ WORKERS_API_KEY: superKey, HIGHLIGHT_API_KEY: 'other' });
        const request = createRequest({ 'X-API-Key': superKey });

        expect(verifyAPIKey(request, env, 'highlight')).toBe(true);
      });
    });

    describe('limitless scope', () => {
      it('should accept MONITORING_API_KEY', () => {
        const key = 'monitoring-key-123';
        const env = createEnv({ MONITORING_API_KEY: key });
        const request = createRequest({ 'X-API-Key': key });

        expect(verifyAPIKey(request, env, 'limitless')).toBe(true);
      });

      it('should accept HIGHLIGHT_API_KEY as cross-scope fallback', () => {
        const highlightKey = 'highlight-key-for-limitless';
        const env = createEnv({
          MONITORING_API_KEY: 'monitoring-key',
          HIGHLIGHT_API_KEY: highlightKey,
        });
        const request = createRequest({ 'X-API-Key': highlightKey });

        expect(verifyAPIKey(request, env, 'limitless')).toBe(true);
      });

      it('should accept via query param (iOS Shortcut)', () => {
        const key = 'monitoring-key-456';
        const env = createEnv({ MONITORING_API_KEY: key });
        const request = new Request(`http://localhost/api/limitless?apiKey=${key}`);

        expect(verifyAPIKey(request, env, 'limitless')).toBe(true);
      });

      it('should reject when no keys configured (fail-closed)', () => {
        const env = createEnv({});
        const request = createRequest({ 'X-API-Key': 'any-key' });

        expect(verifyAPIKey(request, env, 'limitless')).toBe(false);
      });
    });

    describe('monitoring scope', () => {
      it('should accept MONITORING_API_KEY', () => {
        const key = 'monitoring-key-789';
        const env = createEnv({ MONITORING_API_KEY: key });
        const request = createRequest({ 'X-API-Key': key });

        expect(verifyAPIKey(request, env, 'monitoring')).toBe(true);
      });

      it('should fall back to ADMIN_API_KEY when MONITORING_API_KEY not set', () => {
        const adminKey = 'admin-key-for-monitoring';
        const env = createEnv({ ADMIN_API_KEY: adminKey });
        const request = createRequest({ 'X-API-Key': adminKey });

        expect(verifyAPIKey(request, env, 'monitoring')).toBe(true);
      });

      it('should NOT accept query param (security: URL logging)', () => {
        const key = 'monitoring-key-789';
        const env = createEnv({ MONITORING_API_KEY: key });
        const request = new Request(`http://localhost/health?apiKey=${key}`);

        expect(verifyAPIKey(request, env, 'monitoring')).toBe(false);
      });

      it('should prefer MONITORING_API_KEY over ADMIN_API_KEY', () => {
        const monKey = 'monitoring-key';
        const adminKey = 'admin-key';
        const env = createEnv({ MONITORING_API_KEY: monKey, ADMIN_API_KEY: adminKey });

        // monitoring key works
        expect(verifyAPIKey(
          createRequest({ 'X-API-Key': monKey }), env, 'monitoring'
        )).toBe(true);

        // admin key does NOT work (MONITORING_API_KEY takes precedence)
        expect(verifyAPIKey(
          createRequest({ 'X-API-Key': adminKey }), env, 'monitoring'
        )).toBe(false);
      });
    });

    describe('query param scope restriction', () => {
      it('should NOT accept query param for admin scope', () => {
        const key = 'admin-key-secret';
        const env = createEnv({ ADMIN_API_KEY: key });
        const request = new Request(`http://localhost/api/admin?apiKey=${key}`);

        expect(verifyAPIKey(request, env, 'admin')).toBe(false);
      });

      it('should NOT accept query param for queue scope', () => {
        const key = 'queue-key-secret';
        const env = createEnv({ QUEUE_API_KEY: key });
        const request = new Request(`http://localhost/api/queue?apiKey=${key}`);

        expect(verifyAPIKey(request, env, 'queue')).toBe(false);
      });

      it('should NOT accept query param for memory scope', () => {
        const key = 'memory-key-secret';
        const env = createEnv({ MEMORY_API_KEY: key });
        const request = new Request(`http://localhost/api/memory?apiKey=${key}`);

        expect(verifyAPIKey(request, env, 'memory')).toBe(false);
      });
    });
  });

  // ==========================================================================
  // hashAPIKey
  // ==========================================================================
  describe('hashAPIKey', () => {
    it('should return a 16-character hex string', async () => {
      const hash = await hashAPIKey('test-api-key');
      expect(hash).toMatch(/^[a-f0-9]{16}$/);
    });

    it('should produce consistent hashes for same input', async () => {
      const hash1 = await hashAPIKey('consistent-key');
      const hash2 = await hashAPIKey('consistent-key');
      expect(hash1).toBe(hash2);
    });

    it('should produce different hashes for different inputs', async () => {
      const hash1 = await hashAPIKey('key-one');
      const hash2 = await hashAPIKey('key-two');
      expect(hash1).not.toBe(hash2);
    });

    it('should handle empty string input', async () => {
      const hash = await hashAPIKey('');
      expect(hash).toMatch(/^[a-f0-9]{16}$/);
    });

    it('should handle unicode input', async () => {
      const hash = await hashAPIKey('api-key-with-unicode-\u00e9\u00e8\u00ea');
      expect(hash).toMatch(/^[a-f0-9]{16}$/);
    });
  });

  // ==========================================================================
  // extractUserIdFromKey
  // ==========================================================================
  describe('extractUserIdFromKey', () => {
    it('should return mapping when found in KV', async () => {
      const apiKey = 'test-api-key-for-lookup';
      const keyHash = await hashAPIKey(apiKey);
      const mapping = { userId: 'user-123', role: 'user' };

      const mockKV = createMockKV({ [`apikey:mapping:${keyHash}`]: mapping });
      const env = createEnv({ CACHE: mockKV });

      const result = await extractUserIdFromKey(apiKey, env);
      expect(result).toEqual(mapping);
    });

    it('should return null when CACHE is not available', async () => {
      const env = createEnv({});

      const result = await extractUserIdFromKey('any-key', env);
      expect(result).toBeNull();
    });

    it('should return null when no mapping exists', async () => {
      const mockKV = createMockKV({});
      const env = createEnv({ CACHE: mockKV });

      const result = await extractUserIdFromKey('unmapped-key', env);
      expect(result).toBeNull();
    });

    it('should return null when mapping has no userId', async () => {
      const apiKey = 'test-key-no-userid';
      const keyHash = await hashAPIKey(apiKey);
      const mapping = { userId: '', role: 'user' };

      const mockKV = createMockKV({ [`apikey:mapping:${keyHash}`]: mapping });
      const env = createEnv({ CACHE: mockKV });

      const result = await extractUserIdFromKey(apiKey, env);
      expect(result).toBeNull();
    });

    it('should return service role mapping', async () => {
      const apiKey = 'service-daemon-key';
      const keyHash = await hashAPIKey(apiKey);
      const mapping = { userId: 'daemon-001', role: 'service' };

      const mockKV = createMockKV({ [`apikey:mapping:${keyHash}`]: mapping });
      const env = createEnv({ CACHE: mockKV });

      const result = await extractUserIdFromKey(apiKey, env);
      expect(result).toEqual(mapping);
      expect(result?.role).toBe('service');
    });
  });

  // ==========================================================================
  // authorizeUserAccess
  // ==========================================================================
  describe('authorizeUserAccess', () => {
    it('should authorize when userId matches derived userId', async () => {
      const apiKey = 'user-api-key-match';
      const keyHash = await hashAPIKey(apiKey);
      const mapping = { userId: 'user-abc', role: 'user' };

      const mockKV = createMockKV({ [`apikey:mapping:${keyHash}`]: mapping });
      const env = createEnv({ CACHE: mockKV });
      const request = createRequest({ 'X-API-Key': apiKey });

      const result = await authorizeUserAccess(request, 'user-abc', env);
      expect(result).toBe(true);
    });

    it('should reject when userId does not match', async () => {
      const apiKey = 'user-api-key-mismatch';
      const keyHash = await hashAPIKey(apiKey);
      const mapping = { userId: 'user-abc', role: 'user' };

      const mockKV = createMockKV({ [`apikey:mapping:${keyHash}`]: mapping });
      const env = createEnv({ CACHE: mockKV });
      const request = createRequest({ 'X-API-Key': apiKey });

      const result = await authorizeUserAccess(request, 'user-xyz', env);
      expect(result).toBe(false);
    });

    it('should allow service role to access any user data (IDOR bypass)', async () => {
      const apiKey = 'service-daemon-key';
      const keyHash = await hashAPIKey(apiKey);
      const mapping = { userId: 'daemon-001', role: 'service' };

      const mockKV = createMockKV({ [`apikey:mapping:${keyHash}`]: mapping });
      const env = createEnv({ CACHE: mockKV });
      const request = createRequest({ 'X-API-Key': apiKey });

      const result = await authorizeUserAccess(request, 'any-user-id', env);
      expect(result).toBe(true);
    });

    it('should reject when no API key in request', async () => {
      const env = createEnv({ CACHE: createMockKV({}) });
      const request = createRequest({});

      const result = await authorizeUserAccess(request, 'user-123', env);
      expect(result).toBe(false);
    });

    it('should reject when API key has no mapping', async () => {
      const env = createEnv({ CACHE: createMockKV({}) });
      const request = createRequest({ 'X-API-Key': 'unknown-key' });

      const result = await authorizeUserAccess(request, 'user-123', env);
      expect(result).toBe(false);
    });

    it('should reject when derived userId has different length', async () => {
      const apiKey = 'user-key-length-diff';
      const keyHash = await hashAPIKey(apiKey);
      const mapping = { userId: 'short', role: 'user' };

      const mockKV = createMockKV({ [`apikey:mapping:${keyHash}`]: mapping });
      const env = createEnv({ CACHE: mockKV });
      const request = createRequest({ 'X-API-Key': apiKey });

      const result = await authorizeUserAccess(request, 'much-longer-user-id', env);
      expect(result).toBe(false);
    });
  });
});
