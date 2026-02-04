/**
 * Tests for PHI Verification Cron Handler (Phase 6.2)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { handlePhiVerificationCron } from './phi-verification-cron';
import { Env } from '../types';

// Mock global fetch
global.fetch = vi.fn();

const mockEnv: Env = {
  WORKERS_URL: 'https://test.workers.dev',
  MONITORING_API_KEY: 'test-key',
} as Env;

describe('PHI Verification Cron', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls verification API with correct parameters', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          processed: 10,
          verified: 8,
          failed: 2,
          next_batch_available: false,
        },
      }),
    });

    await handlePhiVerificationCron(mockEnv);

    expect(global.fetch).toHaveBeenCalledWith(
      'https://test.workers.dev/api/limitless/verify-phi-batch',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': 'test-key',
        },
        body: JSON.stringify({
          max_items: 50,
          priority: 'low',
        }),
      }
    );
  });

  it('handles successful batch processing', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          processed: 25,
          verified: 20,
          failed: 5,
          next_batch_available: true,
        },
      }),
    });

    await expect(handlePhiVerificationCron(mockEnv)).resolves.toBeUndefined();
  });

  it('handles API errors gracefully', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    });

    await expect(handlePhiVerificationCron(mockEnv)).resolves.toBeUndefined();
  });

  it('handles network errors gracefully', async () => {
    (global.fetch as any).mockRejectedValue(new Error('Network error'));

    await expect(handlePhiVerificationCron(mockEnv)).resolves.toBeUndefined();
  });

  it('uses default WORKERS_URL when not configured', async () => {
    const envWithoutUrl = { ...mockEnv, WORKERS_URL: undefined };

    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: { processed: 0, verified: 0, failed: 0, next_batch_available: false },
      }),
    });

    await handlePhiVerificationCron(envWithoutUrl);

    expect(global.fetch).toHaveBeenCalledWith(
      'https://workers-hub.cursorvers.workers.dev/api/limitless/verify-phi-batch',
      expect.any(Object)
    );
  });
});
