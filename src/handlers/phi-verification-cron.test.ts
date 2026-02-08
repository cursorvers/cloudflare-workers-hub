/**
 * Tests for PHI Verification Cron Handler (Phase 6.2)
 *
 * Implementation calls processPhiVerificationBatch() directly
 * (not via HTTP self-call).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { handlePhiVerificationCron } from './phi-verification-cron';
import { Env } from '../types';

// Mock the verification module
vi.mock('./limitless-phi-verification', () => ({
  processPhiVerificationBatch: vi.fn(),
}));

vi.mock('../utils/log-sanitizer', () => ({
  safeLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { processPhiVerificationBatch } from './limitless-phi-verification';

const mockEnv: Env = {
  WORKERS_URL: 'https://test.workers.dev',
  MONITORING_API_KEY: 'test-key',
} as Env;

describe('PHI Verification Cron', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls processPhiVerificationBatch with max_items=50', async () => {
    (processPhiVerificationBatch as any).mockResolvedValue({
      processed: 10,
      verified: 8,
      failed: 2,
      next_batch_available: false,
    });

    await handlePhiVerificationCron(mockEnv);

    expect(processPhiVerificationBatch).toHaveBeenCalledWith(mockEnv, 50);
  });

  it('handles successful batch processing', async () => {
    (processPhiVerificationBatch as any).mockResolvedValue({
      processed: 25,
      verified: 20,
      failed: 5,
      next_batch_available: true,
    });

    await expect(handlePhiVerificationCron(mockEnv)).resolves.toBeUndefined();
  });

  it('handles errors gracefully', async () => {
    (processPhiVerificationBatch as any).mockRejectedValue(new Error('DB error'));

    await expect(handlePhiVerificationCron(mockEnv)).resolves.toBeUndefined();
  });

  it('logs when more batches are available', async () => {
    const { safeLog } = await import('../utils/log-sanitizer');
    (processPhiVerificationBatch as any).mockResolvedValue({
      processed: 50,
      verified: 48,
      failed: 2,
      next_batch_available: true,
    });

    await handlePhiVerificationCron(mockEnv);

    expect(safeLog.info).toHaveBeenCalledWith(
      expect.stringContaining('More batches available'),
    );
  });
});
