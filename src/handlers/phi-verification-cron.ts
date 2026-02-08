/**
 * PHI Verification Cron Handler (Phase 6.2)
 *
 * Scheduled job to process PHI verification batches every 6 hours.
 * Directly calls processPhiVerificationBatch() instead of HTTP self-call.
 */

import { Env } from '../types';
import { safeLog } from '../utils/log-sanitizer';
import { processPhiVerificationBatch } from './limitless-phi-verification';

// Cron schedule: Every 6 hours — Expression: 0 SLASH-6 * * *
export async function handlePhiVerificationCron(env: Env): Promise<void> {
  safeLog.info('[PHI Verification Cron] Starting batch processing');

  try {
    const result = await processPhiVerificationBatch(env, 50);

    safeLog.info('[PHI Verification Cron] Batch processing completed', {
      processed: result.processed,
      verified: result.verified,
      failed: result.failed,
      next_batch_available: result.next_batch_available,
    });

    if (result.next_batch_available) {
      safeLog.info('[PHI Verification Cron] More batches available, will process in next run');
    }
  } catch (error) {
    safeLog.error('[PHI Verification Cron] Failed to process batch', {
      error: String(error),
    });
  }
}
