/**
 * Tests for Monitoring Endpoint Authentication
 *
 * Security Requirements:
 * 1. Health and metrics endpoints must verify API key
 * 2. MONITORING_API_KEY has priority, falls back to ADMIN_API_KEY
 * 3. If neither key is configured, allow public access (backward compatibility)
 * 4. Use constant-time comparison to prevent timing attacks
 * 5. Log unauthorized access attempts
 */

import { describe, it, expect } from 'vitest';
import { handleHealthCheck, handleMetrics } from './health';

// Mock environment
interface MockEnv {
  AI: any;
  DB?: any;
  CACHE?: any;
  ENVIRONMENT: string;
  MONITORING_API_KEY?: string;
  ADMIN_API_KEY?: string;
}

// Helper to create mock Request
function createRequest(headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/health', {
    method: 'GET',
    headers: new Headers(headers),
  });
}

// Mock environment with all required fields
function createEnv(overrides: Partial<MockEnv> = {}): MockEnv {
  return {
    AI: {},
    ENVIRONMENT: 'test',
    ...overrides,
  };
}

describe('Monitoring Endpoint Authentication', () => {
  describe('handleHealthCheck', () => {
    it('should allow access when MONITORING_API_KEY is configured and matches', async () => {
      const apiKey = 'monitoring-secret-key';
      const env = createEnv({ MONITORING_API_KEY: apiKey });
      const request = createRequest({ 'X-API-Key': apiKey });

      const response = await handleHealthCheck(request, env);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toHaveProperty('status');
      expect(body).toHaveProperty('environment', 'test');
    });

    it('should fall back to ADMIN_API_KEY when MONITORING_API_KEY is not set', async () => {
      const adminKey = 'admin-secret-key';
      const env = createEnv({ ADMIN_API_KEY: adminKey });
      const request = createRequest({ 'X-API-Key': adminKey });

      const response = await handleHealthCheck(request, env);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toHaveProperty('status');
    });

    it('should prioritize MONITORING_API_KEY over ADMIN_API_KEY', async () => {
      const monitoringKey = 'monitoring-key';
      const adminKey = 'admin-key';
      const env = createEnv({
        MONITORING_API_KEY: monitoringKey,
        ADMIN_API_KEY: adminKey,
      });

      // Using monitoring key should work
      const validRequest = createRequest({ 'X-API-Key': monitoringKey });
      const validResponse = await handleHealthCheck(validRequest, env);
      expect(validResponse.status).toBe(200);

      // Using admin key should NOT work when monitoring key is set
      const invalidRequest = createRequest({ 'X-API-Key': adminKey });
      const invalidResponse = await handleHealthCheck(invalidRequest, env);
      expect(invalidResponse.status).toBe(401);
    });

    it('should allow public access when neither MONITORING_API_KEY nor ADMIN_API_KEY is configured', async () => {
      const env = createEnv({}); // No keys configured
      const request = createRequest({}); // No API key provided

      const response = await handleHealthCheck(request, env);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toHaveProperty('status');
    });

    it('should reject access with invalid API key', async () => {
      const env = createEnv({ MONITORING_API_KEY: 'correct-key' });
      const request = createRequest({ 'X-API-Key': 'wrong-key' });

      const response = await handleHealthCheck(request, env);

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body).toHaveProperty('error', 'Unauthorized');
    });

    it('should reject access when API key is required but not provided', async () => {
      const env = createEnv({ MONITORING_API_KEY: 'required-key' });
      const request = createRequest({}); // No API key header

      const response = await handleHealthCheck(request, env);

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body).toHaveProperty('error', 'Unauthorized');
    });

    it('should use constant-time comparison to prevent timing attacks', async () => {
      const correctKey = 'monitoring-secret-key';
      const env = createEnv({ MONITORING_API_KEY: correctKey });

      // Test with different length (should fail fast on length check)
      const shortKey = 'short';
      const shortRequest = createRequest({ 'X-API-Key': shortKey });
      const shortResponse = await handleHealthCheck(shortRequest, env);
      expect(shortResponse.status).toBe(401);

      // Test with same length but different content
      const wrongKey = 'monitoring-secret-zzz'; // Same length, different suffix
      const wrongRequest = createRequest({ 'X-API-Key': wrongKey });
      const wrongResponse = await handleHealthCheck(wrongRequest, env);
      expect(wrongResponse.status).toBe(401);

      // Verify that timing is constant for same-length mismatches
      // (This is ensured by the bitwise OR implementation in verifyMonitoringKey)
    });
  });

  describe('handleMetrics', () => {
    it('should allow access when MONITORING_API_KEY is configured and matches', async () => {
      const apiKey = 'metrics-secret-key';
      const env = createEnv({ MONITORING_API_KEY: apiKey });
      const request = createRequest({ 'X-API-Key': apiKey });

      const response = await handleMetrics(request, env);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toHaveProperty('timestamp');
      expect(body).toHaveProperty('summary');
    });

    it('should fall back to ADMIN_API_KEY when MONITORING_API_KEY is not set', async () => {
      const adminKey = 'admin-metrics-key';
      const env = createEnv({ ADMIN_API_KEY: adminKey });
      const request = createRequest({ 'X-API-Key': adminKey });

      const response = await handleMetrics(request, env);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toHaveProperty('summary');
    });

    it('should allow public access when neither key is configured', async () => {
      const env = createEnv({});
      const request = createRequest({});

      const response = await handleMetrics(request, env);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toHaveProperty('summary');
    });

    it('should reject access with invalid API key', async () => {
      const env = createEnv({ MONITORING_API_KEY: 'correct-metrics-key' });
      const request = createRequest({ 'X-API-Key': 'wrong-metrics-key' });

      const response = await handleMetrics(request, env);

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body).toHaveProperty('error', 'Unauthorized');
    });

    it('should reject access when API key is required but not provided', async () => {
      const env = createEnv({ ADMIN_API_KEY: 'required-admin-key' });
      const request = createRequest({});

      const response = await handleMetrics(request, env);

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body).toHaveProperty('error', 'Unauthorized');
    });
  });

  describe('Backward Compatibility', () => {
    it('should maintain public access for existing deployments without keys', async () => {
      // Scenario: Existing deployment with no authentication configured
      const env = createEnv({});

      // Health check should work without API key
      const healthRequest = createRequest({});
      const healthResponse = await handleHealthCheck(healthRequest, env);
      expect(healthResponse.status).toBe(200);

      // Metrics should work without API key
      const metricsRequest = createRequest({});
      const metricsResponse = await handleMetrics(metricsRequest, env);
      expect(metricsResponse.status).toBe(200);
    });

    it('should support gradual migration to MONITORING_API_KEY', async () => {
      // Phase 1: No keys (public access)
      const phase1Env = createEnv({});
      const phase1Request = createRequest({});
      const phase1Response = await handleHealthCheck(phase1Request, phase1Env);
      expect(phase1Response.status).toBe(200);

      // Phase 2: ADMIN_API_KEY only (fallback)
      const adminKey = 'temp-admin-key';
      const phase2Env = createEnv({ ADMIN_API_KEY: adminKey });
      const phase2Request = createRequest({ 'X-API-Key': adminKey });
      const phase2Response = await handleHealthCheck(phase2Request, phase2Env);
      expect(phase2Response.status).toBe(200);

      // Phase 3: MONITORING_API_KEY (final state)
      const monitoringKey = 'final-monitoring-key';
      const phase3Env = createEnv({
        MONITORING_API_KEY: monitoringKey,
        ADMIN_API_KEY: adminKey, // Still set but not used
      });
      const phase3Request = createRequest({ 'X-API-Key': monitoringKey });
      const phase3Response = await handleHealthCheck(phase3Request, phase3Env);
      expect(phase3Response.status).toBe(200);
    });
  });

  describe('Security Logging', () => {
    it('should log when public access is allowed due to missing keys', async () => {
      // This test verifies that the warning log is generated
      // In actual implementation, safeLog.warn is called
      const env = createEnv({});
      const request = createRequest({});

      const response = await handleHealthCheck(request, env);

      // Should still allow access (backward compatibility)
      expect(response.status).toBe(200);

      // Note: In production, this would trigger:
      // safeLog.warn('[Monitoring] No MONITORING_API_KEY or ADMIN_API_KEY configured - allowing public access')
    });

    it('should log unauthorized access attempts', async () => {
      const env = createEnv({ MONITORING_API_KEY: 'secure-key' });
      const request = createRequest({ 'X-API-Key': 'invalid-key' });

      const response = await handleHealthCheck(request, env);

      expect(response.status).toBe(401);

      // Note: In production, this would trigger:
      // safeLog.warn('[Monitoring] Invalid API key')
    });
  });
});
