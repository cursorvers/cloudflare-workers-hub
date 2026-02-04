/**
 * Tests for PHI Verification API Handler (Phase 6.2)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { handlePhiVerificationAPI } from './limitless-phi-verification';
import { Env } from '../types';

// Mock environment
const mockEnv: Env = {
  SUPABASE_URL: 'https://test.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'test-key',
  MONITORING_API_KEY: 'test-monitoring-key',
  ADMIN_API_KEY: 'test-admin-key',
  ASSISTANT_API_KEY: 'test-assistant-key',
  AI: {
    run: vi.fn(),
  } as any,
  CACHE: {
    get: vi.fn(),
    put: vi.fn(),
  } as any,
} as Env;

// Mock Supabase client
vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    from: vi.fn((table: string) => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          order: vi.fn(() => ({
            limit: vi.fn(() => ({
              then: vi.fn((cb) =>
                cb({
                  data: mockHighlights,
                  error: null,
                })
              ),
            })),
          })),
        })),
      })),
      update: vi.fn(() => ({
        eq: vi.fn(() => ({
          then: vi.fn((cb) => cb({ data: {}, error: null })),
        })),
      })),
    })),
  })),
}));

let mockHighlights: any[] = [];

describe('PHI Verification API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHighlights = [];
  });

  describe('Authentication', () => {
    it('rejects requests without API key', async () => {
      const request = new Request('https://test.com/api/limitless/verify-phi-batch', {
        method: 'POST',
      });

      const response = await handlePhiVerificationAPI(request, mockEnv, '/api/limitless/verify-phi-batch');

      expect(response.status).toBe(401);
      const json = await response.json();
      expect(json.error).toBe('Unauthorized');
    });

    it('accepts valid API key in Authorization header', async () => {
      mockHighlights = [];

      const request = new Request('https://test.com/api/limitless/verify-phi-batch', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer test-monitoring-key',
          'Content-Type': 'application/json',
        },
      });

      const response = await handlePhiVerificationAPI(request, mockEnv, '/api/limitless/verify-phi-batch');

      expect(response.status).toBe(200);
    });

    it('accepts valid API key in X-API-Key header', async () => {
      mockHighlights = [];

      const request = new Request('https://test.com/api/limitless/verify-phi-batch', {
        method: 'POST',
        headers: {
          'X-API-Key': 'test-admin-key',
          'Content-Type': 'application/json',
        },
      });

      const response = await handlePhiVerificationAPI(request, mockEnv, '/api/limitless/verify-phi-batch');

      expect(response.status).toBe(200);
    });
  });

  describe('Batch Processing', () => {
    it('returns empty result when no highlights need verification', async () => {
      mockHighlights = [];

      const request = new Request('https://test.com/api/limitless/verify-phi-batch', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer test-monitoring-key',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          max_items: 10,
          priority: 'low',
        }),
      });

      const response = await handlePhiVerificationAPI(request, mockEnv, '/api/limitless/verify-phi-batch');

      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.success).toBe(true);
      expect(json.data.processed).toBe(0);
      expect(json.data.verified).toBe(0);
      expect(json.data.failed).toBe(0);
      expect(json.data.next_batch_available).toBe(false);
    });

    it('processes batch of highlights with AI verification', async () => {
      mockHighlights = [
        {
          id: '123e4567-e89b-12d3-a456-426614174000',
          extracted_text: 'Patient John Doe discussed wellness',
          phi_confidence_score: 45,
        },
        {
          id: '123e4567-e89b-12d3-a456-426614174001',
          extracted_text: 'Email test@example.com in notes',
          phi_confidence_score: 30,
        },
      ];

      // Mock AI response
      (mockEnv.AI.run as any).mockResolvedValue({
        response: JSON.stringify({
          contains_phi: true,
          confidence: 85,
          reasoning: 'Contains patient name in medical context',
        }),
      });

      const request = new Request('https://test.com/api/limitless/verify-phi-batch', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer test-monitoring-key',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          max_items: 10,
          priority: 'low',
        }),
      });

      const response = await handlePhiVerificationAPI(request, mockEnv, '/api/limitless/verify-phi-batch');

      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.success).toBe(true);
      expect(json.data.processed).toBe(2);
      expect(json.data.verified).toBeGreaterThan(0);
    });

    it('uses default max_items when not specified', async () => {
      mockHighlights = [];

      const request = new Request('https://test.com/api/limitless/verify-phi-batch', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer test-monitoring-key',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      });

      const response = await handlePhiVerificationAPI(request, mockEnv, '/api/limitless/verify-phi-batch');

      expect(response.status).toBe(200);
    });

    it('rejects max_items > 50', async () => {
      const request = new Request('https://test.com/api/limitless/verify-phi-batch', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer test-monitoring-key',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          max_items: 100,
        }),
      });

      const response = await handlePhiVerificationAPI(request, mockEnv, '/api/limitless/verify-phi-batch');

      expect(response.status).toBe(400);
      const json = await response.json();
      expect(json.error).toBe('Validation failed');
    });
  });

  describe('AI Response Parsing', () => {
    it('parses JSON AI response correctly', async () => {
      mockHighlights = [
        {
          id: '123e4567-e89b-12d3-a456-426614174000',
          extracted_text: 'Test text',
          phi_confidence_score: 50,
        },
      ];

      (mockEnv.AI.run as any).mockResolvedValue({
        response: JSON.stringify({
          contains_phi: false,
          confidence: 95,
          reasoning: 'No PHI detected',
        }),
      });

      const request = new Request('https://test.com/api/limitless/verify-phi-batch', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer test-monitoring-key',
        },
      });

      const response = await handlePhiVerificationAPI(request, mockEnv, '/api/limitless/verify-phi-batch');

      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.data.verified).toBe(1);
    });

    it('handles text AI response as fallback', async () => {
      mockHighlights = [
        {
          id: '123e4567-e89b-12d3-a456-426614174000',
          extracted_text: 'Test text',
          phi_confidence_score: 50,
        },
      ];

      (mockEnv.AI.run as any).mockResolvedValue({
        response: 'contains_phi: true, confidence: 75',
      });

      const request = new Request('https://test.com/api/limitless/verify-phi-batch', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer test-monitoring-key',
        },
      });

      const response = await handlePhiVerificationAPI(request, mockEnv, '/api/limitless/verify-phi-batch');

      expect(response.status).toBe(200);
    });
  });

  describe('Weighted Confidence Score', () => {
    it('calculates weighted average of regex + AI confidence', async () => {
      mockHighlights = [
        {
          id: '123e4567-e89b-12d3-a456-426614174000',
          extracted_text: 'Test',
          phi_confidence_score: 40, // Regex confidence
        },
      ];

      (mockEnv.AI.run as any).mockResolvedValue({
        response: JSON.stringify({
          contains_phi: true,
          confidence: 80, // AI confidence
          reasoning: 'Test',
        }),
      });

      const request = new Request('https://test.com/api/limitless/verify-phi-batch', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer test-monitoring-key',
        },
      });

      await handlePhiVerificationAPI(request, mockEnv, '/api/limitless/verify-phi-batch');

      // Expected: (40 * 0.3) + (80 * 0.7) = 12 + 56 = 68
      // Verify update was called with correct value
      // (This would require better mocking to verify the exact value passed to update)
    });
  });

  describe('Error Handling', () => {
    it('continues processing on AI failure for single highlight', async () => {
      mockHighlights = [
        {
          id: '123e4567-e89b-12d3-a456-426614174000',
          extracted_text: 'Test 1',
          phi_confidence_score: 50,
        },
        {
          id: '123e4567-e89b-12d3-a456-426614174001',
          extracted_text: 'Test 2',
          phi_confidence_score: 50,
        },
      ];

      (mockEnv.AI.run as any)
        .mockRejectedValueOnce(new Error('AI service unavailable'))
        .mockResolvedValueOnce({
          response: JSON.stringify({
            contains_phi: false,
            confidence: 90,
            reasoning: 'No PHI',
          }),
        });

      const request = new Request('https://test.com/api/limitless/verify-phi-batch', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer test-monitoring-key',
        },
      });

      const response = await handlePhiVerificationAPI(request, mockEnv, '/api/limitless/verify-phi-batch');

      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.data.processed).toBe(2);
      expect(json.data.verified).toBe(1);
      expect(json.data.failed).toBe(1);
    });
  });

  describe('Routing', () => {
    it('handles /api/limitless/verify-phi-batch endpoint', async () => {
      mockHighlights = [];

      const request = new Request('https://test.com/api/limitless/verify-phi-batch', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer test-monitoring-key',
        },
      });

      const response = await handlePhiVerificationAPI(
        request,
        mockEnv,
        '/api/limitless/verify-phi-batch'
      );

      expect(response.status).toBe(200);
    });

    it('returns 404 for unknown endpoints', async () => {
      const request = new Request('https://test.com/api/limitless/unknown', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer test-monitoring-key',
        },
      });

      const response = await handlePhiVerificationAPI(request, mockEnv, '/api/limitless/unknown');

      expect(response.status).toBe(404);
      const json = await response.json();
      expect(json.error).toBe('Not Found');
    });
  });
});
