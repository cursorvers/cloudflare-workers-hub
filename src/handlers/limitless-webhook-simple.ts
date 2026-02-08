/**
 * Limitless Webhook (KV-free)
 *
 * Goal:
 * - Provide a lightweight, KV-independent trigger endpoint for manual/iPhone use.
 * - Require auth (MONITORING_API_KEY or ADMIN_API_KEY) to avoid exposing a public sync trigger.
 *
 * Notes:
 * - No rate limiting here (KV-free by design). Put this Worker behind Cloudflare Access if desired.
 * - No "recent sync" gating. Idempotency is handled downstream via Supabase upsert on `limitless_id`.
 */

import { z } from 'zod';
import { Env } from '../types';
import { safeLog, maskUserId } from '../utils/log-sanitizer';
import { syncToSupabase } from '../services/limitless';

const WebhookTriggerSchema = z.object({
  userId: z.string().min(1, 'userId is required'),
  maxAgeHours: z.number().min(1).max(72).optional().default(1),
  includeAudio: z.boolean().optional().default(false),
});

function isAuthorized(req: Request, env: Env): boolean {
  const auth = req.headers.get('authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  const token = m[1].trim();
  // If a dedicated webhook key is configured, enforce it as the only auth mechanism.
  // This reduces blast radius from shared keys used by other subsystems.
  if (env.LIMITLESS_SYNC_WEBHOOK_KEY) return token === env.LIMITLESS_SYNC_WEBHOOK_KEY;

  // Backward compatibility fallback: allow existing shared keys when no dedicated key is set.
  if (env.MONITORING_API_KEY && token === env.MONITORING_API_KEY) return true;
  if (env.ADMIN_API_KEY && token === env.ADMIN_API_KEY) return true;
  if (env.WORKERS_API_KEY && token === env.WORKERS_API_KEY) return true;
  return false;
}

export async function handleLimitlessWebhookSimple(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  if (!isAuthorized(request, env)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const parsed = WebhookTriggerSchema.safeParse(body);
  if (!parsed.success) {
    return new Response(JSON.stringify({ error: 'Validation failed', details: parsed.error.errors }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!env.LIMITLESS_API_KEY) {
    return new Response(JSON.stringify({ error: 'LIMITLESS_API_KEY not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { userId, maxAgeHours, includeAudio } = parsed.data;

  const startedAt = Date.now();
  safeLog.info('[Limitless Simple Webhook] Sync triggered', {
    userId: maskUserId(userId),
    maxAgeHours,
    includeAudio,
  });

  try {
    const result = await syncToSupabase(env, env.LIMITLESS_API_KEY, {
      userId,
      maxAgeHours,
      includeAudio,
      maxItems: 5,
      syncSource: 'webhook',
    });

    return new Response(
      JSON.stringify({
        success: true,
        result: {
          synced: result.synced,
          skipped: result.skipped,
          errors: result.errors.length,
          durationMs: Date.now() - startedAt,
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    safeLog.error('[Limitless Simple Webhook] Sync failed', {
      userId: maskUserId(userId),
      error: error instanceof Error ? error.message : String(error),
    });
    return new Response(JSON.stringify({ success: false, error: String(error) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
