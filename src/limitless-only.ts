/**
 * Limitless-only Worker entrypoint (separate project, KV-free)
 *
 * Exposes:
 * - GET  /health
 * - POST /api/limitless/webhook-sync  (auth required; KV-free)
 *
 * Scheduled:
 * - cron: `0 * * * *` (hourly) performs scheduled sync using env.LIMITLESS_USER_ID
 *
 * Design goal:
 * - Keep Limitless ingestion resilient and isolated from other subsystems.
 * - No KV bindings; no distributed locking; rely on Supabase upsert idempotency.
 */

import { Env } from './types';
import { safeLog, maskUserId } from './utils/log-sanitizer';
import { handleLimitlessWebhookSimple } from './handlers/limitless-webhook-simple';
import { syncToSupabase } from './services/limitless';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function handleScheduled(controller: ScheduledController, env: Env): Promise<void> {
  const scheduledTime = new Date(controller.scheduledTime);
  safeLog.info('[Scheduled] Cron trigger fired (limitless-only)', {
    scheduledTime: scheduledTime.toISOString(),
    cron: controller.cron,
  });

  if (env.LIMITLESS_AUTO_SYNC_ENABLED === 'false') {
    safeLog.info('[Scheduled] Limitless auto-sync disabled');
    return;
  }

  if (!env.LIMITLESS_API_KEY) {
    safeLog.warn('[Scheduled] LIMITLESS_API_KEY not configured, skipping');
    return;
  }

  const userId = env.LIMITLESS_USER_ID;
  if (!userId) {
    safeLog.warn('[Scheduled] LIMITLESS_USER_ID not configured, skipping');
    return;
  }

  const syncIntervalHours = parseInt(env.LIMITLESS_SYNC_INTERVAL_HOURS || '1', 10);
  const maxAgeHours = Math.max(1, syncIntervalHours + 2); // tolerate missed runs without exploding cost

  safeLog.info('[Scheduled] Starting Limitless scheduled sync (limitless-only)', {
    userId: maskUserId(userId),
    syncIntervalHours,
    maxAgeHours,
  });

  const startedAt = Date.now();
  try {
    const result = await syncToSupabase(env, env.LIMITLESS_API_KEY, {
      userId,
      maxAgeHours,
      includeAudio: false,
      maxItems: 5,
      // Supabase check constraint currently permits only 'webhook' for processed_lifelogs.sync_source.
      // Keep cron ingestion compatible (provenance can be inferred from logs/metrics if needed).
      syncSource: 'webhook',
    });
    safeLog.info('[Scheduled] Limitless scheduled sync completed (limitless-only)', {
      userId: maskUserId(userId),
      synced: result.synced,
      skipped: result.skipped,
      errors: result.errors.length,
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    safeLog.error('[Scheduled] Limitless scheduled sync failed (limitless-only)', {
      userId: maskUserId(userId),
      error: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - startedAt,
    });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/health') {
      // Intentionally minimal and safe to expose.
      return json({
        status: 'ok',
        worker: 'limitless-only',
        time: new Date().toISOString(),
      });
    }

    if (path === '/api/limitless/webhook-sync') {
      return handleLimitlessWebhookSimple(request, env);
    }

    return json({ error: 'Not Found' }, 404);
  },

  async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    await handleScheduled(controller, env);
  },
};
