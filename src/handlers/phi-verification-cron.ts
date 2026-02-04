/**
 * PHI Verification Cron Handler (Phase 6.2)
 *
 * Scheduled job to process PHI verification batches every 6 hours.
 * Runs AI Gateway verification on highlights with needs_ai_verification = true.
 */

import { Env } from '../types';
import { safeLog } from '../utils/log-sanitizer';

/**
 * Cron schedule: Every 6 hours
 * Expression: "0 star-slash-6 * * *" (At minute 0 past every 6th hour)
 */
export async function handlePhiVerificationCron(env: Env): Promise<void> {
  safeLog.info('[PHI Verification Cron] Starting batch processing');

  try {
    // Call our own API endpoint for batch processing
    const apiUrl = `${env.WORKERS_URL || 'https://workers-hub.cursorvers.workers.dev'}/api/limitless/verify-phi-batch`;

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': env.MONITORING_API_KEY || '',
      },
      body: JSON.stringify({
        max_items: 50, // Process up to 50 items per run
        priority: 'low',
      }),
    });

    if (!response.ok) {
      throw new Error(`API call failed: ${response.status} ${response.statusText}`);
    }

    const result = await response.json();

    safeLog.info('[PHI Verification Cron] Batch processing completed', {
      processed: result.data?.processed || 0,
      verified: result.data?.verified || 0,
      failed: result.data?.failed || 0,
      next_batch_available: result.data?.next_batch_available || false,
    });

    // If more batches are available, schedule another run
    // (This will be handled by the next cron trigger in 6 hours)
    if (result.data?.next_batch_available) {
      safeLog.info('[PHI Verification Cron] More batches available, will process in next run');
    }
  } catch (error) {
    safeLog.error('[PHI Verification Cron] Failed to process batch', {
      error: String(error),
    });
  }
}
