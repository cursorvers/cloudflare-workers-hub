/**
 * Tests for Admin API Handler
 *
 * Test Coverage:
 * 1. API key verification with admin scope
 * 2. Rate limiting for admin endpoints
 * 3. Create API key mapping (POST /api/admin/apikey/mapping)
 * 4. Delete API key mapping (DELETE /api/admin/apikey/mapping)
 * 5. Zod schema validation
 * 6. Error handling (unauthorized, rate limit, validation, server errors)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleAdminAPI } from './admin-api';
import { Env } from '../types';

// Mock dependencies
vi.mock('../utils/log-sanitizer', () => ({
  safeLog: {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  maskUserId: vi.fn((userId: string) => userId.replace(/./g, '*')),
}));

vi.mock('../utils/rate-limiter', () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
  createRateLimitResponse: vi.fn().mockReturnValue(
    new Response(JSON.stringify({ error: 'Rate limit exceeded' }), {
      status: 429,
      headers: { 'Content-Type': 'application/json' },
    })
  ),
}));

vi.mock('../utils/api-auth', () => ({
  verifyAPIKey: vi.fn((request: Request, env: Env, scope?: string) => {
    const apiKey = request.headers.get('X-API-Key');
    return apiKey === 'admin-key' && scope === 'admin';
  }),
  hashAPIKey: vi.fn((key: string) => `hashed_${key}`),
}));

// Helper to create mock Env
function createMockEnv(): Env {
  const cache = new Map<string, string>();

  return {
    ADMIN_API_KEY: 'admin-key',
    CACHE: {
      get: vi.fn((key: string) => Promise.resolve(cache.get(key) || null)),
      put: vi.fn((key: string, value: string) => {
        cache.set(key, value);
        return Promise.resolve();
      }),
      delete: vi.fn((key: string) => {
        cache.delete(key);
        return Promise.resolve();
      }),
      list: vi.fn(),
      getWithMetadata: vi.fn(),
    } as any,
  } as Env;
}

describe('Admin API Handler', () => {
  let env: Env;

  beforeEach(async () => {
    env = createMockEnv();
    vi.clearAllMocks();

    const { checkRateLimit, createRateLimitResponse } = await import('../utils/rate-limiter');
    const { verifyAPIKey, hashAPIKey } = await import('../utils/api-auth');

    vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true, remaining: 100, resetAt: new Date() });
    vi.mocked(verifyAPIKey).mockImplementation((request: Request, envParam: Env, scope?: string) => {
      const apiKey = request.headers.get('X-API-Key');
      return apiKey === 'admin-key' && scope === 'admin';
    });
  });

  describe('Authentication', () => {
    it('should reject requests without API key', async () => {
      const request = new Request('https://example.com/api/admin/apikey/mapping', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiKey: 'user-key',
          userId: 'user123',
          role: 'user',
        }),
      });

      const response = await handleAdminAPI(request, env, '/api/admin/apikey/mapping');

      expect(response.status).toBe(401);
      const data = await response.json() as { error: string };
      expect(data.error).toBe('Unauthorized');
    });

    it('should reject requests with non-admin API key', async () => {
      const { verifyAPIKey } = await import('../utils/api-auth');
      vi.mocked(verifyAPIKey).mockReturnValueOnce(false);

      const request = new Request('https://example.com/api/admin/apikey/mapping', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': 'user-key',
        },
        body: JSON.stringify({
          apiKey: 'user-key',
          userId: 'user123',
          role: 'user',
        }),
      });

      const response = await handleAdminAPI(request, env, '/api/admin/apikey/mapping');

      expect(response.status).toBe(401);
    });

    it('should accept requests with admin API key', async () => {
      const request = new Request('https://example.com/api/admin/apikey/mapping', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': 'admin-key',
        },
        body: JSON.stringify({
          apiKey: 'user-key',
          userId: 'user123',
          role: 'user',
        }),
      });

      const response = await handleAdminAPI(request, env, '/api/admin/apikey/mapping');

      expect(response.status).toBe(201);
    });
  });

  describe('Rate Limiting', () => {
    it('should check rate limit for admin endpoints', async () => {
      const { checkRateLimit } = await import('../utils/rate-limiter');

      const request = new Request('https://example.com/api/admin/apikey/mapping', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': 'admin-key',
        },
        body: JSON.stringify({
          apiKey: 'user-key',
          userId: 'user123',
          role: 'user',
        }),
      });

      await handleAdminAPI(request, env, '/api/admin/apikey/mapping');

      expect(checkRateLimit).toHaveBeenCalledWith(
        env,
        'admin',
        expect.any(String)
      );
    });

    it('should reject when rate limit exceeded', async () => {
      const { checkRateLimit } = await import('../utils/rate-limiter');
      vi.mocked(checkRateLimit).mockResolvedValueOnce({ allowed: false, remaining: 0, resetAt: new Date(), retryAfter: 60 });

      const request = new Request('https://example.com/api/admin/apikey/mapping', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': 'admin-key',
        },
        body: JSON.stringify({
          apiKey: 'user-key',
          userId: 'user123',
          role: 'user',
        }),
      });

      const response = await handleAdminAPI(request, env, '/api/admin/apikey/mapping');

      expect(response.status).toBe(429);
    });
  });

  describe('Create API Key Mapping', () => {
    it('should create API key mapping successfully', async () => {
      const request = new Request('https://example.com/api/admin/apikey/mapping', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': 'admin-key',
        },
        body: JSON.stringify({
          apiKey: 'user-key-123',
          userId: 'user123',
          role: 'user',
        }),
      });

      const response = await handleAdminAPI(request, env, '/api/admin/apikey/mapping');

      expect(response.status).toBe(201);
      const data = await response.json() as { success: boolean; userId: string; role: string; keyHash: string };
      expect(data.success).toBe(true);
      expect(data.userId).toBe('user123');
      expect(data.role).toBe('user');
      expect(data.keyHash).toBeDefined();
    });

    it('should validate request body with Zod schema', async () => {
      const request = new Request('https://example.com/api/admin/apikey/mapping', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': 'admin-key',
        },
        body: JSON.stringify({
          // Missing required fields
          apiKey: 'user-key',
        }),
      });

      const response = await handleAdminAPI(request, env, '/api/admin/apikey/mapping');

      expect(response.status).toBe(400);
    });

    it('should store mapping in CACHE with correct key format', async () => {
      const request = new Request('https://example.com/api/admin/apikey/mapping', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': 'admin-key',
        },
        body: JSON.stringify({
          apiKey: 'user-key-123',
          userId: 'user123',
          role: 'user',
        }),
      });

      await handleAdminAPI(request, env, '/api/admin/apikey/mapping');

      expect(env.CACHE!.put).toHaveBeenCalledWith(
        expect.stringMatching(/^apikey:mapping:hashed_/),
        expect.stringContaining('user123')
      );
    });

    it('should return 500 when CACHE is unavailable', async () => {
      const envWithoutCache = { ...env, CACHE: undefined } as Env;

      const request = new Request('https://example.com/api/admin/apikey/mapping', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': 'admin-key',
        },
        body: JSON.stringify({
          apiKey: 'user-key',
          userId: 'user123',
          role: 'user',
        }),
      });

      const response = await handleAdminAPI(request, envWithoutCache, '/api/admin/apikey/mapping');

      expect(response.status).toBe(500);
    });
  });

  describe('Delete API Key Mapping', () => {
    it('should delete API key mapping successfully', async () => {
      const request = new Request('https://example.com/api/admin/apikey/mapping', {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': 'admin-key',
        },
        body: JSON.stringify({
          apiKey: 'user-key-123',
        }),
      });

      const response = await handleAdminAPI(request, env, '/api/admin/apikey/mapping');

      expect(response.status).toBe(200);
      const data = await response.json() as { success: boolean; keyHash: string };
      expect(data.success).toBe(true);
      expect(data.keyHash).toBeDefined();
    });

    it('should validate delete request body', async () => {
      const request = new Request('https://example.com/api/admin/apikey/mapping', {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': 'admin-key',
        },
        body: JSON.stringify({
          // Missing apiKey
        }),
      });

      const response = await handleAdminAPI(request, env, '/api/admin/apikey/mapping');

      expect(response.status).toBe(400);
    });

    it('should call CACHE.delete with correct key', async () => {
      const request = new Request('https://example.com/api/admin/apikey/mapping', {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': 'admin-key',
        },
        body: JSON.stringify({
          apiKey: 'user-key-123',
        }),
      });

      await handleAdminAPI(request, env, '/api/admin/apikey/mapping');

      expect(env.CACHE.delete).toHaveBeenCalledWith(
        expect.stringMatching(/^apikey:mapping:hashed_/)
      );
    });
  });

  describe('Error Handling', () => {
    it('should return 404 for unknown endpoints', async () => {
      const request = new Request('https://example.com/api/admin/unknown', {
        method: 'GET',
        headers: {
          'X-API-Key': 'admin-key',
        },
      });

      const response = await handleAdminAPI(request, env, '/api/admin/unknown');

      expect(response.status).toBe(404);
    });

    it('should handle exceptions gracefully', async () => {
      vi.mocked(env.CACHE.put).mockRejectedValueOnce(new Error('Database error'));

      const request = new Request('https://example.com/api/admin/apikey/mapping', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': 'admin-key',
        },
        body: JSON.stringify({
          apiKey: 'user-key',
          userId: 'user123',
          role: 'user',
        }),
      });

      const response = await handleAdminAPI(request, env, '/api/admin/apikey/mapping');

      expect(response.status).toBe(500);
      const data = await response.json();
      expect(data.error).toContain('Failed to create');
    });
  });
});
