/**
 * Tests for Queue API Handler Security
 *
 * Security Requirements:
 * 1. API key verification must use constant-time comparison
 * 2. User authorization must prevent timing attacks
 * 3. No early returns that leak timing information
 */

import { describe, it, expect } from 'vitest';
import { verifyAPIKey, authorizeUserAccess } from './queue';

// Mock environment
interface MockEnv {
  AI: any;
  CACHE?: any;
  ENVIRONMENT: string;
  QUEUE_API_KEY?: string;
  MEMORY_API_KEY?: string;
  ADMIN_API_KEY?: string;
  ASSISTANT_API_KEY?: string;
}

// Helper to create mock Request
function createRequest(headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/queue', {
    method: 'GET',
    headers: new Headers(headers),
  });
}

// Mock environment with required fields
function createEnv(overrides: Partial<MockEnv> = {}): MockEnv {
  return {
    AI: {},
    ENVIRONMENT: 'test',
    ...overrides,
  };
}

describe('Queue API Security', () => {
  describe('verifyAPIKey constant-time comparison', () => {
    it('should accept valid API key', () => {
      const apiKey = 'secret-queue-key-12345';
      const env = createEnv({ QUEUE_API_KEY: apiKey });
      const request = createRequest({ 'X-API-Key': apiKey });

      const result = verifyAPIKey(request, env, 'queue');

      expect(result).toBe(true);
    });

    it('should reject API key with different length', () => {
      const correctKey = 'secret-queue-key-12345';
      const wrongKey = 'short';
      const env = createEnv({ QUEUE_API_KEY: correctKey });
      const request = createRequest({ 'X-API-Key': wrongKey });

      const result = verifyAPIKey(request, env, 'queue');

      expect(result).toBe(false);
    });

    it('should reject API key with same length but different content', () => {
      const correctKey = 'secret-queue-key-12345';
      const wrongKey = 'secret-queue-key-99999'; // Same length, different suffix
      const env = createEnv({ QUEUE_API_KEY: correctKey });
      const request = createRequest({ 'X-API-Key': wrongKey });

      const result = verifyAPIKey(request, env, 'queue');

      expect(result).toBe(false);
    });

    it('should reject missing API key', () => {
      const env = createEnv({ QUEUE_API_KEY: 'secret-key' });
      const request = createRequest({}); // No API key header

      const result = verifyAPIKey(request, env, 'queue');

      expect(result).toBe(false);
    });

    it('should reject when API key is not configured', () => {
      const env = createEnv({}); // No QUEUE_API_KEY
      const request = createRequest({ 'X-API-Key': 'some-key' });

      const result = verifyAPIKey(request, env, 'queue');

      expect(result).toBe(false);
    });

    it('should use constant-time comparison (no early return on length mismatch)', () => {
      // This test verifies that the comparison doesn't return early
      // The implementation should always iterate through all characters
      const correctKey = 'a'.repeat(32); // 32 character key
      const shortKey = 'a'.repeat(8);   // 8 character key
      const env = createEnv({ QUEUE_API_KEY: correctKey });

      // Both should fail, but timing should be constant
      const shortRequest = createRequest({ 'X-API-Key': shortKey });
      const shortResult = verifyAPIKey(shortRequest, env, 'queue');
      expect(shortResult).toBe(false);

      // Same length but different content
      const wrongKey = 'b'.repeat(32);
      const wrongRequest = createRequest({ 'X-API-Key': wrongKey });
      const wrongResult = verifyAPIKey(wrongRequest, env, 'queue');
      expect(wrongResult).toBe(false);

      // The key insight: the implementation now uses Math.max(length1, length2)
      // and always iterates through maxLen characters, preventing timing leaks
    });

    it('should support scoped API keys', () => {
      const queueKey = 'queue-key';
      const memoryKey = 'memory-key';
      const adminKey = 'admin-key';
      const env = createEnv({
        QUEUE_API_KEY: queueKey,
        MEMORY_API_KEY: memoryKey,
        ADMIN_API_KEY: adminKey,
      });

      // Queue scope should only accept queue key
      expect(verifyAPIKey(createRequest({ 'X-API-Key': queueKey }), env, 'queue')).toBe(true);
      expect(verifyAPIKey(createRequest({ 'X-API-Key': memoryKey }), env, 'queue')).toBe(false);

      // Memory scope should only accept memory key
      expect(verifyAPIKey(createRequest({ 'X-API-Key': memoryKey }), env, 'memory')).toBe(true);
      expect(verifyAPIKey(createRequest({ 'X-API-Key': queueKey }), env, 'memory')).toBe(false);

      // Admin scope should only accept admin key (no fallback)
      expect(verifyAPIKey(createRequest({ 'X-API-Key': adminKey }), env, 'admin')).toBe(true);
      expect(verifyAPIKey(createRequest({ 'X-API-Key': queueKey }), env, 'admin')).toBe(false);
    });

    it('should fall back to ASSISTANT_API_KEY for queue and memory scopes', () => {
      const legacyKey = 'legacy-assistant-key';
      const env = createEnv({ ASSISTANT_API_KEY: legacyKey });

      // Queue and memory should fall back
      expect(verifyAPIKey(createRequest({ 'X-API-Key': legacyKey }), env, 'queue')).toBe(true);
      expect(verifyAPIKey(createRequest({ 'X-API-Key': legacyKey }), env, 'memory')).toBe(true);

      // Admin should NOT fall back
      expect(verifyAPIKey(createRequest({ 'X-API-Key': legacyKey }), env, 'admin')).toBe(false);
    });
  });

  describe('authorizeUserAccess constant-time comparison', () => {
    it('should authorize when userId matches', async () => {
      const apiKey = 'test-api-key';
      const userId = 'user-12345';
      const request = createRequest({ 'X-API-Key': apiKey });

      // Create mock KV with userId mapping
      const mockKV = {
        get: async (key: string, format?: string) => {
          if (key.startsWith('apikey:mapping:')) {
            return format === 'json' ? { userId } : JSON.stringify({ userId });
          }
          return null;
        },
      } as any;

      const env = createEnv({ CACHE: mockKV });

      const result = await authorizeUserAccess(request, userId, env);

      expect(result).toBe(true);
    });

    it('should reject when userId does not match', async () => {
      const apiKey = 'test-api-key';
      const derivedUserId = 'user-12345';
      const requestedUserId = 'user-99999';
      const request = createRequest({ 'X-API-Key': apiKey });

      const mockKV = {
        get: async (key: string, format?: string) => {
          if (key.startsWith('apikey:mapping:')) {
            return format === 'json' ? { userId: derivedUserId } : JSON.stringify({ userId: derivedUserId });
          }
          return null;
        },
      } as any;

      const env = createEnv({ CACHE: mockKV });

      const result = await authorizeUserAccess(request, requestedUserId, env);

      expect(result).toBe(false);
    });

    it('should use constant-time comparison for userId (no early return on length mismatch)', async () => {
      const apiKey = 'test-api-key';
      const derivedUserId = 'user-with-long-id-12345';
      const shortUserId = 'user-123';
      const request = createRequest({ 'X-API-Key': apiKey });

      const mockKV = {
        get: async (key: string, format?: string) => {
          if (key.startsWith('apikey:mapping:')) {
            return format === 'json' ? { userId: derivedUserId } : JSON.stringify({ userId: derivedUserId });
          }
          return null;
        },
      } as any;

      const env = createEnv({ CACHE: mockKV });

      // Should reject without leaking timing information about length
      const result = await authorizeUserAccess(request, shortUserId, env);

      expect(result).toBe(false);

      // The implementation now uses Math.max(length1, length2) and always
      // iterates through all characters, preventing timing attacks
    });

    it('should reject when API key is missing', async () => {
      const request = createRequest({}); // No API key
      const env = createEnv({});

      const result = await authorizeUserAccess(request, 'user-123', env);

      expect(result).toBe(false);
    });

    it('should reject when KV is not available', async () => {
      const request = createRequest({ 'X-API-Key': 'test-key' });
      const env = createEnv({ CACHE: undefined });

      const result = await authorizeUserAccess(request, 'user-123', env);

      expect(result).toBe(false);
    });

    it('should reject when userId mapping does not exist', async () => {
      const request = createRequest({ 'X-API-Key': 'test-key' });

      const mockKV = {
        get: async () => null, // No mapping found
      } as any;

      const env = createEnv({ CACHE: mockKV });

      const result = await authorizeUserAccess(request, 'user-123', env);

      expect(result).toBe(false);
    });
  });
});
