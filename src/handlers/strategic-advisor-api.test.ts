/**
 * Tests for Strategic Advisor API Handler
 *
 * Test Coverage:
 * 1. Authentication - CF Access, API Key, JWT
 * 2. GET /api/advisor/context - strategic context retrieval
 * 3. GET /api/advisor/insights - insights with query params
 * 4. POST /api/advisor/insights/:id/feedback - feedback submission
 * 5. POST /api/advisor/sync - Plans.md sync with path validation
 * 6. GET /api/advisor/goals - goals listing with status filter
 * 7. GET /api/advisor/analytics - feedback analytics
 * 8. Error handling and route matching
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleAdvisorAPI } from './strategic-advisor-api';
import type { Env } from '../types';

// Mock dependencies
vi.mock('../utils/log-sanitizer', () => ({
  safeLog: {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../utils/cloudflare-access', () => ({
  authenticateWithAccess: vi.fn().mockResolvedValue({ verified: false }),
  mapAccessUserToInternal: vi.fn().mockResolvedValue(null),
}));

vi.mock('../services/strategic-context', () => ({
  getStrategicContext: vi.fn().mockResolvedValue({
    goals: [
      { id: 'goal-1', title: 'Test Goal', status: 'active', progress: 50 },
    ],
    currentPhase: 'Phase 1',
  }),
  getInsights: vi.fn().mockResolvedValue([
    {
      id: 'insight-1',
      type: 'strategic',
      title: 'Test Insight',
      confidence: 80,
    },
  ]),
  submitInsightFeedback: vi.fn().mockResolvedValue(true),
  syncPlansContent: vi.fn().mockResolvedValue(undefined),
  getInsightById: vi.fn().mockResolvedValue({
    id: 'insight-1',
    type: 'strategic',
    confidence: 80,
  }),
}));

vi.mock('../services/feedback-learning', () => ({
  recordFeedback: vi.fn().mockResolvedValue(undefined),
  getFeedbackAnalytics: vi.fn().mockResolvedValue({
    totalFeedback: 10,
    acceptRate: 0.6,
    dismissRate: 0.3,
    snoozeRate: 0.1,
    preferredTypes: ['strategic'],
    dislikedTypes: [],
  }),
}));

// Helper to create mock Env
function createMockEnv(): Env {
  return {
    QUEUE_API_KEY: 'test-queue-key',
    CACHE: {
      get: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
      list: vi.fn(),
      getWithMetadata: vi.fn(),
    } as any,
  } as Env;
}

describe('Strategic Advisor API Handler', () => {
  let env: Env;

  beforeEach(async () => {
    env = createMockEnv();
    vi.clearAllMocks();
  });

  describe('Authentication', () => {
    it('should reject requests without authentication', async () => {
      const request = new Request('https://example.com/api/advisor/context', {
        method: 'GET',
      });

      const response = await handleAdvisorAPI(request, env, '/api/advisor/context');

      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error).toContain('authentication');
    });

    it('should accept requests with valid API key', async () => {
      const request = new Request('https://example.com/api/advisor/context', {
        method: 'GET',
        headers: {
          'X-API-Key': 'test-queue-key',
        },
      });

      const response = await handleAdvisorAPI(request, env, '/api/advisor/context');

      expect(response.status).toBe(200);
    });

    it('should accept requests with CF Access authentication', async () => {
      const { authenticateWithAccess, mapAccessUserToInternal } = await import(
        '../utils/cloudflare-access'
      );
      vi.mocked(authenticateWithAccess).mockResolvedValueOnce({
        verified: true,
        email: 'user@example.com',
      });
      vi.mocked(mapAccessUserToInternal).mockResolvedValueOnce({
        userId: 'user-1',
        role: 'admin',
      });

      const request = new Request('https://example.com/api/advisor/context', {
        method: 'GET',
      });

      const response = await handleAdvisorAPI(request, env, '/api/advisor/context');

      expect(response.status).toBe(200);
    });
  });

  describe('GET /api/advisor/context', () => {
    it('should return strategic context', async () => {
      const request = new Request('https://example.com/api/advisor/context', {
        method: 'GET',
        headers: { 'X-API-Key': 'test-queue-key' },
      });

      const response = await handleAdvisorAPI(request, env, '/api/advisor/context');

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.data).toHaveProperty('goals');
      expect(data.data).toHaveProperty('currentPhase');
    });

    it('should handle service errors gracefully', async () => {
      const { getStrategicContext } = await import('../services/strategic-context');
      vi.mocked(getStrategicContext).mockRejectedValueOnce(new Error('Service error'));

      const request = new Request('https://example.com/api/advisor/context', {
        method: 'GET',
        headers: { 'X-API-Key': 'test-queue-key' },
      });

      const response = await handleAdvisorAPI(request, env, '/api/advisor/context');

      expect(response.status).toBe(500);
    });
  });

  describe('GET /api/advisor/insights', () => {
    it('should return insights with default options', async () => {
      const request = new Request('https://example.com/api/advisor/insights', {
        method: 'GET',
        headers: { 'X-API-Key': 'test-queue-key' },
      });

      const response = await handleAdvisorAPI(request, env, '/api/advisor/insights');

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.meta.limit).toBe(3); // Default limit
    });

    it('should parse query parameters', async () => {
      const { getInsights } = await import('../services/strategic-context');

      const request = new Request(
        'https://example.com/api/advisor/insights?limit=5&types=strategic,tactical&includeDismissed=true',
        {
          method: 'GET',
          headers: { 'X-API-Key': 'test-queue-key' },
        }
      );

      await handleAdvisorAPI(request, env, '/api/advisor/insights');

      expect(getInsights).toHaveBeenCalledWith(
        env,
        expect.objectContaining({
          limit: 5,
          types: ['strategic', 'tactical'],
          includeDismissed: true,
        })
      );
    });

    it('should return validation error for invalid params', async () => {
      const request = new Request(
        'https://example.com/api/advisor/insights?limit=abc',
        {
          method: 'GET',
          headers: { 'X-API-Key': 'test-queue-key' },
        }
      );

      const response = await handleAdvisorAPI(request, env, '/api/advisor/insights');

      expect(response.status).toBe(400);
    });
  });

  describe('POST /api/advisor/insights/:id/feedback', () => {
    it('should accept valid feedback', async () => {
      const request = new Request(
        'https://example.com/api/advisor/insights/insight-1/feedback',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-API-Key': 'test-queue-key',
          },
          body: JSON.stringify({
            action: 'accepted',
            feedback: 'Great insight!',
          }),
        }
      );

      const response = await handleAdvisorAPI(
        request,
        env,
        '/api/advisor/insights/insight-1/feedback'
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
    });

    it('should record feedback for learning', async () => {
      const { recordFeedback } = await import('../services/feedback-learning');
      const { authenticateWithAccess, mapAccessUserToInternal } = await import(
        '../utils/cloudflare-access'
      );

      vi.mocked(authenticateWithAccess).mockResolvedValueOnce({
        verified: true,
        email: 'user@example.com',
      });
      vi.mocked(mapAccessUserToInternal).mockResolvedValueOnce({
        userId: 'user-1',
        role: 'user',
      });

      const request = new Request(
        'https://example.com/api/advisor/insights/insight-1/feedback',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'accepted' }),
        }
      );

      await handleAdvisorAPI(
        request,
        env,
        '/api/advisor/insights/insight-1/feedback'
      );

      expect(recordFeedback).toHaveBeenCalledWith(
        env,
        'user-1',
        expect.objectContaining({
          insightId: 'insight-1',
          action: 'accepted',
        })
      );
    });

    it('should reject invalid action', async () => {
      const request = new Request(
        'https://example.com/api/advisor/insights/insight-1/feedback',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-API-Key': 'test-queue-key',
          },
          body: JSON.stringify({
            action: 'invalid-action',
          }),
        }
      );

      const response = await handleAdvisorAPI(
        request,
        env,
        '/api/advisor/insights/insight-1/feedback'
      );

      expect(response.status).toBe(400);
    });
  });

  describe('POST /api/advisor/sync', () => {
    it('should sync plans content', async () => {
      const { syncPlansContent } = await import('../services/strategic-context');

      const request = new Request('https://example.com/api/advisor/sync', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': 'test-queue-key',
        },
        body: JSON.stringify({
          content: '# Plans\n\n## Tasks\n- [ ] Task 1',
          filePath: 'docs/Plans.md',
        }),
      });

      const response = await handleAdvisorAPI(request, env, '/api/advisor/sync');

      expect(response.status).toBe(200);
      expect(syncPlansContent).toHaveBeenCalledWith(
        env,
        '# Plans\n\n## Tasks\n- [ ] Task 1',
        'docs/Plans.md'
      );
    });

    it('should reject path traversal attempts', async () => {
      const request = new Request('https://example.com/api/advisor/sync', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': 'test-queue-key',
        },
        body: JSON.stringify({
          content: 'malicious content',
          filePath: '../../../etc/passwd.md',
        }),
      });

      const response = await handleAdvisorAPI(request, env, '/api/advisor/sync');

      // Path traversal is caught by Zod regex validation (no .. or / at start)
      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toContain('Invalid');
    });

    it('should reject invalid file paths', async () => {
      const request = new Request('https://example.com/api/advisor/sync', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': 'test-queue-key',
        },
        body: JSON.stringify({
          content: 'content',
          filePath: 'not-a-markdown.txt',
        }),
      });

      const response = await handleAdvisorAPI(request, env, '/api/advisor/sync');

      expect(response.status).toBe(400);
    });

    it('should reject empty content', async () => {
      const request = new Request('https://example.com/api/advisor/sync', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': 'test-queue-key',
        },
        body: JSON.stringify({
          content: '',
          filePath: 'docs/Plans.md',
        }),
      });

      const response = await handleAdvisorAPI(request, env, '/api/advisor/sync');

      expect(response.status).toBe(400);
    });
  });

  describe('GET /api/advisor/goals', () => {
    it('should return goals list', async () => {
      const request = new Request('https://example.com/api/advisor/goals', {
        method: 'GET',
        headers: { 'X-API-Key': 'test-queue-key' },
      });

      const response = await handleAdvisorAPI(request, env, '/api/advisor/goals');

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
      expect(Array.isArray(data.data)).toBe(true);
    });

    it('should filter goals by status', async () => {
      const { getStrategicContext } = await import('../services/strategic-context');
      vi.mocked(getStrategicContext).mockResolvedValueOnce({
        goals: [
          { id: 'goal-1', status: 'active' },
          { id: 'goal-2', status: 'completed' },
          { id: 'goal-3', status: 'active' },
        ],
        currentPhase: 'Phase 1',
      });

      const request = new Request(
        'https://example.com/api/advisor/goals?status=active',
        {
          method: 'GET',
          headers: { 'X-API-Key': 'test-queue-key' },
        }
      );

      const response = await handleAdvisorAPI(request, env, '/api/advisor/goals');

      const data = await response.json();
      expect(data.data.length).toBe(2);
      expect(data.data.every((g: any) => g.status === 'active')).toBe(true);
    });
  });

  describe('GET /api/advisor/analytics', () => {
    it('should return analytics for authenticated user', async () => {
      const { authenticateWithAccess, mapAccessUserToInternal } = await import(
        '../utils/cloudflare-access'
      );
      vi.mocked(authenticateWithAccess).mockResolvedValueOnce({
        verified: true,
        email: 'user@example.com',
      });
      vi.mocked(mapAccessUserToInternal).mockResolvedValueOnce({
        userId: 'user-1',
        role: 'user',
      });

      const request = new Request('https://example.com/api/advisor/analytics', {
        method: 'GET',
      });

      const response = await handleAdvisorAPI(request, env, '/api/advisor/analytics');

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.data).toHaveProperty('acceptRate');
    });

    it('should require user ID for analytics', async () => {
      // System user (API key auth) has userId but the function checks for it
      const request = new Request('https://example.com/api/advisor/analytics', {
        method: 'GET',
        headers: { 'X-API-Key': 'test-queue-key' },
      });

      const response = await handleAdvisorAPI(request, env, '/api/advisor/analytics');

      // System user should work
      expect(response.status).toBe(200);
    });
  });

  describe('Route Matching', () => {
    it('should return 404 for unknown routes', async () => {
      const request = new Request('https://example.com/api/advisor/unknown', {
        method: 'GET',
        headers: { 'X-API-Key': 'test-queue-key' },
      });

      const response = await handleAdvisorAPI(request, env, '/api/advisor/unknown');

      expect(response.status).toBe(404);
    });

    it('should match insight feedback route with ID', async () => {
      const request = new Request(
        'https://example.com/api/advisor/insights/abc-123/feedback',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-API-Key': 'test-queue-key',
          },
          body: JSON.stringify({ action: 'dismissed' }),
        }
      );

      const response = await handleAdvisorAPI(
        request,
        env,
        '/api/advisor/insights/abc-123/feedback'
      );

      expect(response.status).toBe(200);
    });
  });
});
