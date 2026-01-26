/**
 * Tests for Limitless Webhook Handler
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { handleLimitlessWebhook } from './limitless-webhook';
import { Env } from '../types';

// Mock the dependencies
vi.mock('../utils/log-sanitizer', () => ({
  safeLog: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  maskUserId: (id: string) => id.substring(0, 4) + '***',
}));

vi.mock('../utils/rate-limiter', () => ({
  checkRateLimit: vi.fn().mockResolvedValue({
    allowed: true,
    remaining: 50,
    resetAt: Date.now() + 60000,
  }),
  createRateLimitResponse: vi.fn((result) => new Response(JSON.stringify({ error: 'Rate limited' }), { status: 429 })),
  addRateLimitHeaders: vi.fn((response) => response),
}));

vi.mock('../services/limitless', () => ({
  syncToSupabase: vi.fn().mockResolvedValue({
    synced: 3,
    skipped: 1,
    errors: [],
  }),
}));

// Helper to create mock env
function createMockEnv(overrides: Partial<Env> = {}): Env {
  const mockKV = {
    get: vi.fn().mockResolvedValue(null),
    put: vi.fn().mockResolvedValue(undefined),
  } as unknown as KVNamespace;

  return {
    AI: {} as any,
    CACHE: mockKV,
    LIMITLESS_API_KEY: 'test-api-key',
    MONITORING_API_KEY: 'test-monitoring-key',
    ENVIRONMENT: 'test',
    ...overrides,
  };
}

// Helper to create mock request
function createMockRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('https://example.com/api/limitless/webhook-sync', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe('handleLimitlessWebhook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Request Validation', () => {
    it('should reject invalid JSON', async () => {
      const env = createMockEnv();
      const request = new Request('https://example.com/api/limitless/webhook-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'invalid json',
      });

      const response = await handleLimitlessWebhook(request, env);
      expect(response.status).toBe(400);

      const data = await response.json();
      expect(data).toHaveProperty('error', 'Invalid JSON in request body');
    });

    it('should reject missing userId', async () => {
      const env = createMockEnv();
      const request = createMockRequest({
        // Missing userId
        maxAgeHours: 1,
      });

      const response = await handleLimitlessWebhook(request, env);
      expect(response.status).toBe(400);

      const data = await response.json();
      expect(data).toHaveProperty('error', 'Validation failed');
    });

    it('should reject invalid maxAgeHours', async () => {
      const env = createMockEnv();
      const request = createMockRequest({
        userId: 'test-user',
        maxAgeHours: 25, // Over 24
      });

      const response = await handleLimitlessWebhook(request, env);
      expect(response.status).toBe(400);

      const data = await response.json();
      expect(data).toHaveProperty('error', 'Validation failed');
    });

    it('should accept minimal valid request', async () => {
      const env = createMockEnv();
      const request = createMockRequest({
        userId: 'test-user',
      });

      const response = await handleLimitlessWebhook(request, env);
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data).toHaveProperty('success', true);
    });

    it('should accept full valid request', async () => {
      const env = createMockEnv();
      const request = createMockRequest({
        userId: 'test-user',
        triggerSource: 'ios_shortcut',
        maxAgeHours: 2,
        includeAudio: true,
      });

      const response = await handleLimitlessWebhook(request, env);
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data).toHaveProperty('success', true);
      expect(data.result).toHaveProperty('synced', 3);
    });
  });

  describe('Authentication', () => {
    it('should work without authentication', async () => {
      const env = createMockEnv();
      const request = createMockRequest({
        userId: 'test-user',
      });

      const response = await handleLimitlessWebhook(request, env);
      expect(response.status).toBe(200);
    });

    it('should accept valid bearer token', async () => {
      const env = createMockEnv();
      const request = createMockRequest(
        { userId: 'test-user' },
        { Authorization: 'Bearer test-monitoring-key' }
      );

      const response = await handleLimitlessWebhook(request, env);
      expect(response.status).toBe(200);
    });

    it('should reject invalid bearer token', async () => {
      const env = createMockEnv();
      const request = createMockRequest(
        { userId: 'test-user' },
        { Authorization: 'Bearer wrong-key' }
      );

      const response = await handleLimitlessWebhook(request, env);
      // Should still work but use stricter rate limit
      expect(response.status).toBe(200);
    });
  });

  describe('Configuration Checks', () => {
    it('should return 500 if LIMITLESS_API_KEY not configured', async () => {
      const env = createMockEnv({ LIMITLESS_API_KEY: undefined });
      const request = createMockRequest({
        userId: 'test-user',
      });

      const response = await handleLimitlessWebhook(request, env);
      expect(response.status).toBe(500);

      const data = await response.json();
      expect(data).toHaveProperty('error', 'Limitless integration not configured');
    });
  });

  describe('Deduplication', () => {
    it('should skip sync if last sync was recent', async () => {
      const env = createMockEnv();
      const mockKV = env.CACHE as any;

      // Mock that last sync was 5 minutes ago (within 10-minute window)
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      mockKV.get.mockResolvedValue(fiveMinutesAgo);

      const request = createMockRequest({
        userId: 'test-user',
        maxAgeHours: 1,
      });

      const response = await handleLimitlessWebhook(request, env);
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data).toHaveProperty('skipped', true);
      expect(data).toHaveProperty('reason', 'Recent sync already completed');
      expect(data).toHaveProperty('lastSync');
      expect(data).toHaveProperty('nextAllowedSync');
    });

    it('should allow sync if last sync was > 10 minutes ago', async () => {
      const env = createMockEnv();
      const mockKV = env.CACHE as any;

      // Mock that last sync was 15 minutes ago (outside 10-minute window)
      const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();
      mockKV.get.mockResolvedValue(fifteenMinutesAgo);

      const request = createMockRequest({
        userId: 'test-user',
        maxAgeHours: 1,
      });

      const response = await handleLimitlessWebhook(request, env);
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data).toHaveProperty('success', true);
      expect(data).not.toHaveProperty('skipped');
    });

    it('should allow sync if no previous sync exists', async () => {
      const env = createMockEnv();
      const mockKV = env.CACHE as any;

      // Mock that no previous sync exists
      mockKV.get.mockResolvedValue(null);

      const request = createMockRequest({
        userId: 'test-user',
      });

      const response = await handleLimitlessWebhook(request, env);
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data).toHaveProperty('success', true);
    });

    it('should calculate interval based on maxAgeHours', async () => {
      const env = createMockEnv();
      const mockKV = env.CACHE as any;

      // For maxAgeHours=4, minInterval should be 20 minutes (4 * 5)
      const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();
      mockKV.get.mockResolvedValue(fifteenMinutesAgo);

      const request = createMockRequest({
        userId: 'test-user',
        maxAgeHours: 4, // Should require 20-minute gap
      });

      const response = await handleLimitlessWebhook(request, env);
      expect(response.status).toBe(200);

      const data = await response.json();
      // 15 minutes < 20 minutes, so should be skipped
      expect(data).toHaveProperty('skipped', true);
    });
  });

  describe('Sync Execution', () => {
    it('should call syncToSupabase with correct parameters', async () => {
      const { syncToSupabase } = await import('../services/limitless');
      const env = createMockEnv();
      const request = createMockRequest({
        userId: 'test-user',
        maxAgeHours: 2,
        includeAudio: true,
      });

      await handleLimitlessWebhook(request, env);

      expect(syncToSupabase).toHaveBeenCalledWith(
        env,
        'test-api-key',
        {
          userId: 'test-user',
          maxAgeHours: 2,
          includeAudio: true,
        }
      );
    });

    it('should return sync results', async () => {
      const env = createMockEnv();
      const request = createMockRequest({
        userId: 'test-user',
      });

      const response = await handleLimitlessWebhook(request, env);
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data).toHaveProperty('success', true);
      expect(data.result).toHaveProperty('synced', 3);
      expect(data.result).toHaveProperty('skipped', 1);
      expect(data.result).toHaveProperty('errors', 0);
      expect(data.result).toHaveProperty('durationMs');
    });

    it('should handle sync errors gracefully', async () => {
      const { syncToSupabase } = await import('../services/limitless');
      (syncToSupabase as any).mockRejectedValueOnce(new Error('Sync failed'));

      const env = createMockEnv();
      const request = createMockRequest({
        userId: 'test-user',
      });

      const response = await handleLimitlessWebhook(request, env);
      expect(response.status).toBe(500);

      const data = await response.json();
      expect(data).toHaveProperty('success', false);
      expect(data).toHaveProperty('error', 'Sync failed');
    });
  });

  describe('KV Updates', () => {
    it('should update last sync timestamp after successful sync', async () => {
      const env = createMockEnv();
      const mockKV = env.CACHE as any;
      const request = createMockRequest({
        userId: 'test-user',
      });

      await handleLimitlessWebhook(request, env);

      // Should call put for last sync timestamp
      expect(mockKV.put).toHaveBeenCalledWith(
        'limitless:webhook_last_sync:test-user',
        expect.any(String),
        { expirationTtl: 86400 }
      );

      // Should call put for stats
      expect(mockKV.put).toHaveBeenCalledWith(
        'limitless:webhook_stats:test-user',
        expect.any(String),
        { expirationTtl: 604800 }
      );
    });

    it('should increment totalSyncs in stats', async () => {
      const env = createMockEnv();
      const mockKV = env.CACHE as any;

      // Mock existing stats - handle 'json' type argument
      mockKV.get.mockImplementation((key: string, type?: string) => {
        if (key === 'limitless:webhook_stats:test-user') {
          const stats = { totalSyncs: 5 };
          // When called with 'json', return parsed object; otherwise return string
          return Promise.resolve(type === 'json' ? stats : JSON.stringify(stats));
        }
        return Promise.resolve(null);
      });

      const request = createMockRequest({
        userId: 'test-user',
      });

      await handleLimitlessWebhook(request, env);

      // Find the stats update call
      const statsCalls = mockKV.put.mock.calls.filter(
        (call: any[]) => call[0] === 'limitless:webhook_stats:test-user'
      );

      expect(statsCalls.length).toBeGreaterThan(0);
      const statsData = JSON.parse(statsCalls[0][1]);
      expect(statsData.totalSyncs).toBe(6); // 5 + 1
    });
  });

  describe('Rate Limiting', () => {
    it('should return 429 if rate limit exceeded', async () => {
      const { checkRateLimit, createRateLimitResponse } = await import('../utils/rate-limiter');
      (checkRateLimit as any).mockResolvedValueOnce({
        allowed: false,
        remaining: 0,
        resetAt: Date.now() + 60000,
        retryAfter: 60,
      });

      const env = createMockEnv();
      const request = createMockRequest({
        userId: 'test-user',
      });

      await handleLimitlessWebhook(request, env);

      expect(createRateLimitResponse).toHaveBeenCalled();
    });

    it('should use stricter limit for unauthenticated requests', async () => {
      const { checkRateLimit } = await import('../utils/rate-limiter');

      const env = createMockEnv();
      const request = createMockRequest({
        userId: 'test-user',
      });

      await handleLimitlessWebhook(request, env);

      expect(checkRateLimit).toHaveBeenCalledWith(
        env,
        'limitless_webhook_public',
        expect.any(String)
      );
    });

    it('should use relaxed limit for authenticated requests', async () => {
      const { checkRateLimit } = await import('../utils/rate-limiter');

      const env = createMockEnv();
      const request = createMockRequest(
        { userId: 'test-user' },
        { Authorization: 'Bearer test-monitoring-key' }
      );

      await handleLimitlessWebhook(request, env);

      expect(checkRateLimit).toHaveBeenCalledWith(
        env,
        'limitless_webhook_auth',
        expect.any(String)
      );
    });
  });

  describe('Response Format', () => {
    it('should include rate limit headers in success response', async () => {
      const { addRateLimitHeaders } = await import('../utils/rate-limiter');

      const env = createMockEnv();
      const request = createMockRequest({
        userId: 'test-user',
      });

      await handleLimitlessWebhook(request, env);

      expect(addRateLimitHeaders).toHaveBeenCalled();
    });

    it('should include proper message in success response', async () => {
      const env = createMockEnv();
      const request = createMockRequest({
        userId: 'test-user',
      });

      const response = await handleLimitlessWebhook(request, env);
      const data = await response.json();

      expect(data.message).toBe('Successfully synced 3 recording(s)');
    });

    it('should include Content-Type header', async () => {
      const env = createMockEnv();
      const request = createMockRequest({
        userId: 'test-user',
      });

      const response = await handleLimitlessWebhook(request, env);

      expect(response.headers.get('Content-Type')).toBe('application/json');
    });
  });
});
