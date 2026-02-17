/**
 * Limitless Backfill Handler
 *
 * POST /api/limitless/backfill
 * Auth: Bearer token (same as webhook-sync)
 *
 * Accepts a single time range and pages through it.
 * Designed to be called day-by-day from a local shell script.
 * Idempotent via Supabase upsert on `limitless_id`.
 */

import { z } from 'zod';
import { Env } from '../types';
import { safeLog } from '../utils/log-sanitizer';
import { syncRangeToSupabase } from '../services/limitless';

const BackfillRequestSchema = z.object({
  startTime: z.string().datetime(),
  endTime: z.string().datetime(),
  cursor: z.string().optional(),
  pageSize: z.number().min(1).max(10).optional().default(5),
  maxPages: z.number().min(1).max(20).optional().default(10),
});

function isAuthorized(req: Request, env: Env): boolean {
  const auth = req.headers.get('authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  const token = m[1].trim();
  const validKeys = [
    env.LIMITLESS_SYNC_WEBHOOK_KEY,
    env.MONITORING_API_KEY,
    env.ADMIN_API_KEY,
    env.WORKERS_API_KEY,
  ].filter(Boolean);
  return validKeys.some(key => key === token);
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function handleLimitlessBackfill(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') {
    return json({ error: 'Method Not Allowed' }, 405);
  }

  if (!isAuthorized(request, env)) {
    return json({ error: 'Unauthorized' }, 401);
  }

  if (!env.LIMITLESS_API_KEY) {
    return json({ error: 'LIMITLESS_API_KEY not configured' }, 500);
  }

  const userId = env.LIMITLESS_USER_ID;
  if (!userId) {
    return json({ error: 'LIMITLESS_USER_ID not configured' }, 500);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const parsed = BackfillRequestSchema.safeParse(body);
  if (!parsed.success) {
    return json({ error: 'Validation failed', details: parsed.error.issues }, 400);
  }

  const { startTime, endTime, cursor, pageSize, maxPages } = parsed.data;

  safeLog.info('[Backfill] Starting range sync', { startTime, endTime, pageSize, maxPages });

  const startedAt = Date.now();
  try {
    const result = await syncRangeToSupabase(env, env.LIMITLESS_API_KEY, {
      userId,
      startTime,
      endTime,
      cursor,
      pageSize,
      maxPages,
      includeAudio: false,
      syncSource: 'manual',
    });

    safeLog.info('[Backfill] Range sync completed', {
      synced: result.synced,
      skipped: result.skipped,
      errors: result.errors.length,
      done: result.done,
      durationMs: Date.now() - startedAt,
    });

    return json({
      synced: result.synced,
      skipped: result.skipped,
      errors: result.errors,
      nextCursor: result.nextCursor,
      done: result.done,
      pagesProcessed: result.pagesProcessed,
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    safeLog.error('[Backfill] Range sync failed', {
      error: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - startedAt,
    });
    return json(
      { error: 'Backfill failed', message: error instanceof Error ? error.message : String(error) },
      500
    );
  }
}
