/**
 * Limitless Webhook Handler
 *
 * Lightweight webhook endpoint for iOS Shortcuts to trigger Limitless sync.
 * Design:
 * - Simple POST endpoint with optional authentication
 * - Rate limiting to prevent abuse
 * - User identification via request body or header
 * - Async processing via queue or immediate sync
 */

import { Env } from '../types';
import { safeLog, maskUserId } from '../utils/log-sanitizer';
import { checkRateLimit, createRateLimitResponse, addRateLimitHeaders } from '../utils/rate-limiter';
import { syncToSupabase } from '../services/limitless';
import { z } from 'zod';

// Validation schema for webhook trigger
const WebhookTriggerSchema = z.object({
  userId: z.string().min(1, 'User ID is required'),
  triggerSource: z.enum(['ios_shortcut', 'notification', 'manual']).optional().default('ios_shortcut'),
  maxAgeHours: z.number().min(1).max(24).optional().default(1), // Default to last 1 hour for iPhone triggers
  includeAudio: z.boolean().optional().default(false),
});

export type WebhookTriggerRequest = z.infer<typeof WebhookTriggerSchema>;

/**
 * Handle Limitless webhook trigger from iOS Shortcuts
 *
 * POST /api/limitless/webhook-sync
 *
 * Request body:
 * {
 *   "userId": "user-123",
 *   "triggerSource": "ios_shortcut",
 *   "maxAgeHours": 1  // Optional, defaults to 1 hour
 * }
 *
 * Or simple format:
 * {
 *   "userId": "user-123"
 * }
 *
 * Authentication:
 * - Optional Bearer token in Authorization header
 * - If no auth, rate limiting is stricter (10 req/min per IP)
 * - With auth, rate limiting is relaxed (60 req/min per user)
 */
export async function handleLimitlessWebhook(
  request: Request,
  env: Env
): Promise<Response> {
  // Extract client identifier for rate limiting
  const clientId = getClientIdentifier(request);

  // Check authentication
  const hasAuth = checkAuthentication(request, env);

  // Apply rate limiting (stricter for unauthenticated requests)
  const rateLimit = hasAuth ? 'limitless_webhook_auth' : 'limitless_webhook_public';
  const rateLimitResult = await checkRateLimit(env, rateLimit, clientId);

  if (!rateLimitResult.allowed) {
    safeLog.warn('[Limitless Webhook] Rate limit exceeded', {
      clientId: maskUserId(clientId),
      hasAuth,
    });
    return createRateLimitResponse(rateLimitResult);
  }

  // Parse request body
  let body: unknown;
  try {
    body = await request.json();
  } catch (error) {
    return new Response(
      JSON.stringify({
        error: 'Invalid JSON in request body',
        message: 'Request body must be valid JSON',
      }),
      {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  // Validate request
  const validation = WebhookTriggerSchema.safeParse(body);
  if (!validation.success) {
    return new Response(
      JSON.stringify({
        error: 'Validation failed',
        details: validation.error.errors,
      }),
      {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  const syncRequest = validation.data;

  // Verify Limitless API key is configured
  if (!env.LIMITLESS_API_KEY) {
    safeLog.error('[Limitless Webhook] LIMITLESS_API_KEY not configured');
    return new Response(
      JSON.stringify({
        error: 'Limitless integration not configured',
        message: 'Server is not configured for Limitless sync',
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  safeLog.info('[Limitless Webhook] Sync triggered', {
    userId: maskUserId(syncRequest.userId),
    triggerSource: syncRequest.triggerSource,
    maxAgeHours: syncRequest.maxAgeHours,
    hasAuth,
  });

  try {
    // Check for recent sync to avoid duplicate processing
    const shouldSync = await checkShouldSync(env, syncRequest.userId, syncRequest.maxAgeHours);

    if (!shouldSync.allowed) {
      safeLog.info('[Limitless Webhook] Skipping sync (too recent)', {
        userId: maskUserId(syncRequest.userId),
        lastSync: shouldSync.lastSync,
        minInterval: shouldSync.minInterval,
      });

      return addRateLimitHeaders(
        new Response(
          JSON.stringify({
            success: true,
            skipped: true,
            reason: 'Recent sync already completed',
            lastSync: shouldSync.lastSync,
            nextAllowedSync: shouldSync.nextAllowedSync,
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }
        ),
        rateLimitResult
      );
    }

    // Perform sync
    const startTime = Date.now();
    const result = await syncToSupabase(env, env.LIMITLESS_API_KEY, {
      userId: syncRequest.userId,
      maxAgeHours: syncRequest.maxAgeHours,
      includeAudio: syncRequest.includeAudio,
      maxItems: 5, // Workers Free Tier: 50 subrequest limit (5 items × ~8 calls + overhead)
      syncSource: 'webhook',
    });

    const duration = Date.now() - startTime;

    // Update last sync timestamp
    await updateLastSync(env, syncRequest.userId, syncRequest.triggerSource);

    safeLog.info('[Limitless Webhook] Sync completed', {
      userId: maskUserId(syncRequest.userId),
      synced: result.synced,
      skipped: result.skipped,
      errors: result.errors.length,
      durationMs: duration,
    });

    return addRateLimitHeaders(
      new Response(
        JSON.stringify({
          success: true,
          result: {
            synced: result.synced,
            skipped: result.skipped,
            errors: result.errors.length,
            durationMs: duration,
          },
          message: `Successfully synced ${result.synced} recording(s)`,
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      ),
      rateLimitResult
    );
  } catch (error) {
    safeLog.error('[Limitless Webhook] Sync failed', {
      userId: maskUserId(syncRequest.userId),
      error: String(error),
    });

    return addRateLimitHeaders(
      new Response(
        JSON.stringify({
          success: false,
          error: 'Sync failed',
          details: String(error),
        }),
        {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }
      ),
      rateLimitResult
    );
  }
}

/**
 * Get client identifier for rate limiting
 * Priority: userId > IP address
 */
function getClientIdentifier(request: Request): string {
  // Try to get CF-Connecting-IP (Cloudflare provides this)
  const cfIP = request.headers.get('CF-Connecting-IP');
  if (cfIP) {
    return cfIP;
  }

  // Fallback to X-Forwarded-For
  const forwardedFor = request.headers.get('X-Forwarded-For');
  if (forwardedFor) {
    return forwardedFor.split(',')[0].trim();
  }

  // Last resort: use a placeholder
  return 'unknown';
}

/**
 * Check authentication
 * Returns true if valid bearer token is provided
 */
function checkAuthentication(request: Request, env: Env): boolean {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return false;
  }

  const token = authHeader.substring(7);

  // Check against configured API keys
  if (env.MONITORING_API_KEY && token === env.MONITORING_API_KEY) {
    return true;
  }

  if (env.ASSISTANT_API_KEY && token === env.ASSISTANT_API_KEY) {
    return true;
  }

  // Could add support for user-specific tokens here
  return false;
}

/**
 * Check if sync should proceed based on last sync time
 * Prevents duplicate syncs within a short time window
 */
async function checkShouldSync(
  env: Env,
  userId: string,
  maxAgeHours: number
): Promise<{
  allowed: boolean;
  lastSync?: string;
  minInterval?: number;
  nextAllowedSync?: string;
}> {
  if (!env.CACHE) {
    return { allowed: true };
  }

  try {
    // Determine minimum interval based on maxAgeHours
    // For 1-hour syncs (typical iPhone trigger), require 10 min gap
    // For longer syncs, require proportional gap
    const minIntervalMinutes = Math.max(10, maxAgeHours * 5);
    const minIntervalMs = minIntervalMinutes * 60 * 1000;

    const lastSyncKey = `limitless:webhook_last_sync:${userId}`;
    const lastSyncData = await env.CACHE.get(lastSyncKey);

    if (!lastSyncData) {
      return { allowed: true };
    }

    const lastSync = new Date(lastSyncData);
    const timeSinceLastSync = Date.now() - lastSync.getTime();

    if (timeSinceLastSync < minIntervalMs) {
      const nextAllowedSync = new Date(lastSync.getTime() + minIntervalMs);
      return {
        allowed: false,
        lastSync: lastSync.toISOString(),
        minInterval: minIntervalMinutes,
        nextAllowedSync: nextAllowedSync.toISOString(),
      };
    }

    return { allowed: true };
  } catch {
    // KV failure — allow sync to proceed
    return { allowed: true };
  }
}

/**
 * Update last sync timestamp in KV
 */
async function updateLastSync(
  env: Env,
  userId: string,
  triggerSource: string
): Promise<void> {
  if (!env.CACHE) {
    return;
  }

  try {
    const now = new Date().toISOString();
    const lastSyncKey = `limitless:webhook_last_sync:${userId}`;

    // Store last sync timestamp (expires after 24 hours)
    await env.CACHE.put(lastSyncKey, now, {
      expirationTtl: 86400, // 24 hours
    });

    // Update webhook stats
    const statsKey = `limitless:webhook_stats:${userId}`;
    const existingStats = await env.CACHE.get(statsKey, 'json');

    const stats = {
      lastSync: now,
      triggerSource,
      totalSyncs: ((existingStats as any)?.totalSyncs || 0) + 1,
    };

    await env.CACHE.put(statsKey, JSON.stringify(stats), {
      expirationTtl: 604800, // 7 days
    });
  } catch {
    // KV failure is non-fatal — sync already completed
    safeLog.warn('[Limitless Webhook] Failed to update last sync timestamp (KV limit?)');
  }
}
