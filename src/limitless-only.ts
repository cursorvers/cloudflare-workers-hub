/**
 * Limitless-only Worker entrypoint (separate project, KV-free)
 *
 * Exposes:
 * - GET  /health
 * - POST /api/limitless/webhook-sync  (auth required; KV-free)
 * - POST /api/limitless/backfill      (auth required; day-by-day range sync)
 *
 * Scheduled:
 * - cron: `0 * * * *` (hourly) performs scheduled sync using env.LIMITLESS_USER_ID
 *
 * Design goal:
 * - Keep Limitless ingestion resilient and isolated from other subsystems.
 * - No KV bindings; rely on Supabase upsert idempotency + sync_cursor for state.
 * - Optimistic locking on sync_cursor prevents duplicate processing across Workers.
 */

import { Env } from './types';
import { safeLog, maskUserId } from './utils/log-sanitizer';
import { handleLimitlessWebhookSimple } from './handlers/limitless-webhook-simple';
import { handleLimitlessBackfill } from './handlers/limitless-backfill';
import { syncToSupabase } from './services/limitless';
import { getCursor, updateCursor } from './services/sync-cursor';
import { SupabaseConfig } from './services/supabase-client';

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

  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    safeLog.warn('[Scheduled] Supabase not configured, skipping');
    return;
  }

  const supabaseConfig: SupabaseConfig = {
    url: env.SUPABASE_URL,
    serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
  };

  // Phase 2: Read persistent cursor (fallback to 24h window)
  const cursor = await getCursor(supabaseConfig, 'limitless');
  const endTime = new Date();
  const maxAgeHours = Math.ceil(
    (endTime.getTime() - cursor.startTime.getTime()) / (60 * 60 * 1000)
  );

  safeLog.info('[Scheduled] Starting Limitless scheduled sync (cursor-based)', {
    userId: maskUserId(userId),
    startTime: cursor.startTime.toISOString(),
    usedFallback: cursor.usedFallback,
    fallbackReason: cursor.reason,
    maxAgeHours,
  });

  const startedAt = Date.now();
  try {
    const result = await syncToSupabase(env, env.LIMITLESS_API_KEY, {
      userId,
      maxAgeHours,
      includeAudio: false,
      maxItems: 50,
      syncSource: 'webhook',
    });

    // Determine new cursor value: latest lifelog endTime, or now() if no data
    const newCursorValue = endTime;

    // Update cursor (optimistic lock; safe to skip on conflict)
    const updated = await updateCursor(
      supabaseConfig,
      'limitless',
      newCursorValue,
      cursor.updatedAt,
      result.synced,
      result.errors.length > 0 ? result.errors[0] : null
    );

    safeLog.info('[Scheduled] Limitless scheduled sync completed (cursor-based)', {
      userId: maskUserId(userId),
      synced: result.synced,
      skipped: result.skipped,
      errors: result.errors.length,
      cursorUpdated: updated,
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    // Record error in cursor but don't advance it
    await updateCursor(
      supabaseConfig,
      'limitless',
      cursor.startTime,
      cursor.updatedAt,
      0,
      error instanceof Error ? error.message : String(error)
    ).catch(() => {});

    safeLog.error('[Scheduled] Limitless scheduled sync failed (cursor-based)', {
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

    if (path === '/api/limitless/backfill') {
      return handleLimitlessBackfill(request, env);
    }

    return json({ error: 'Not Found' }, 404);
  },

  async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    await handleScheduled(controller, env);
  },
};
