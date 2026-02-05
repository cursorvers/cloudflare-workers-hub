/**
 * Limitless API Handler
 *
 * Provides endpoints for Limitless.ai integration:
 * - GET /api/limitless/sync - Manual trigger for syncing lifelogs
 * - POST /api/limitless/sync - Sync with custom options
 * - GET /api/limitless/config - Get current configuration
 * - Scheduled sync support via cron
 */

import { Env } from '../types';
import { safeLog, maskUserId } from '../utils/log-sanitizer';
import { checkRateLimit, createRateLimitResponse } from '../utils/rate-limiter';
import { syncToSupabase, LimitlessConfig } from '../services/limitless';
import { z } from 'zod';

// Validation schemas
const SyncRequestSchema = z.object({
  userId: z.string().min(1, 'User ID is required'),
  maxAgeHours: z.number().min(1).max(168).optional().default(24),
  includeAudio: z.boolean().optional().default(false),
  syncSource: z.enum(['webhook', 'backup', 'manual']).optional(),
});

/**
 * Handle Limitless API requests
 */
export async function handleLimitlessAPI(
  request: Request,
  env: Env,
  path: string
): Promise<Response> {
  // Verify API key (require MONITORING_API_KEY for sync operations)
  const apiKey = extractAPIKey(request);
  if (!apiKey || !verifyAPIKey(apiKey, env)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Rate limit check
  const rateLimitResult = await checkRateLimit(request, env, apiKey.substring(0, 8));
  if (!rateLimitResult.allowed) {
    return createRateLimitResponse(rateLimitResult);
  }

  // GET /api/limitless/sync - Manual sync trigger
  if (path === '/api/limitless/sync' && request.method === 'GET') {
    return handleManualSync(request, env);
  }

  // POST /api/limitless/sync - Sync with custom options
  if (path === '/api/limitless/sync' && request.method === 'POST') {
    return handleCustomSync(request, env);
  }

  // GET /api/limitless/config - Get configuration
  if (path === '/api/limitless/config' && request.method === 'GET') {
    return handleGetConfig(env);
  }

  // Phase 5: Metrics API
  if (path === '/api/limitless/metrics' && request.method === 'GET') {
    const { handleLimitlessMetricsAPI } = await import('./limitless-metrics');
    return handleLimitlessMetricsAPI(request, env);
  }

  // Phase 5: Reflection API
  if (path.startsWith('/api/limitless/reflection') || path.startsWith('/api/limitless/pending-reviews')) {
    const { handleLimitlessReflectionAPI } = await import('./limitless-reflection');
    return handleLimitlessReflectionAPI(request, env, path);
  }

  // Phase 6.2: PHI Verification API
  if (path.startsWith('/api/limitless/verify-phi')) {
    const { handlePhiVerificationAPI } = await import('./limitless-phi-verification');
    return handlePhiVerificationAPI(request, env, path);
  }

  // Unknown endpoint
  return new Response(JSON.stringify({ error: 'Not Found' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Handle manual sync (GET /api/limitless/sync)
 * Uses default configuration from environment variables
 */
async function handleManualSync(request: Request, env: Env): Promise<Response> {
  // Extract userId from query parameter
  const url = new URL(request.url);
  const userId = url.searchParams.get('userId');

  if (!userId) {
    return new Response(
      JSON.stringify({
        error: 'Missing required parameter: userId',
      }),
      {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  // Get Limitless API key from environment
  const limitlessApiKey = env.LIMITLESS_API_KEY;
  if (!limitlessApiKey) {
    safeLog.error('[Limitless API] LIMITLESS_API_KEY not configured');
    return new Response(
      JSON.stringify({
        error: 'Limitless API not configured',
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  safeLog.info('[Limitless API] Manual sync triggered', {
    userId: maskUserId(userId),
  });

  try {
    // Perform sync
    const result = await syncToSupabase(env, limitlessApiKey, {
      userId,
      maxAgeHours: 24, // Default: last 24 hours
      includeAudio: false, // Default: don't download audio
      syncSource: 'manual',
    });

    safeLog.info('[Limitless API] Manual sync completed', {
      userId: maskUserId(userId),
      synced: result.synced,
      skipped: result.skipped,
      errors: result.errors.length,
    });

    return new Response(
      JSON.stringify({
        success: true,
        result,
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    safeLog.error('[Limitless API] Manual sync failed', {
      userId: maskUserId(userId),
      error: String(error),
    });

    return new Response(
      JSON.stringify({
        error: 'Sync failed',
        details: String(error),
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}

/**
 * Handle custom sync (POST /api/limitless/sync)
 * Allows custom options via request body
 */
async function handleCustomSync(request: Request, env: Env): Promise<Response> {
  // Parse and validate request body
  let body: unknown;
  try {
    body = await request.json();
  } catch (error) {
    return new Response(
      JSON.stringify({
        error: 'Invalid JSON in request body',
      }),
      {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  // Validate request body
  const validation = SyncRequestSchema.safeParse(body);
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

  const syncOptions = validation.data;

  // Get Limitless API key from environment
  const limitlessApiKey = env.LIMITLESS_API_KEY;
  if (!limitlessApiKey) {
    safeLog.error('[Limitless API] LIMITLESS_API_KEY not configured');
    return new Response(
      JSON.stringify({
        error: 'Limitless API not configured',
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  safeLog.info('[Limitless API] Custom sync triggered', {
    userId: maskUserId(syncOptions.userId),
    maxAgeHours: syncOptions.maxAgeHours,
    includeAudio: syncOptions.includeAudio,
  });

  try {
    // Perform sync
    const result = await syncToSupabase(env, limitlessApiKey, { ...syncOptions, syncSource: syncOptions.syncSource ?? 'manual' });

    safeLog.info('[Limitless API] Custom sync completed', {
      userId: maskUserId(syncOptions.userId),
      synced: result.synced,
      skipped: result.skipped,
      errors: result.errors.length,
    });

    return new Response(
      JSON.stringify({
        success: true,
        result,
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    safeLog.error('[Limitless API] Custom sync failed', {
      userId: maskUserId(syncOptions.userId),
      error: String(error),
    });

    return new Response(
      JSON.stringify({
        error: 'Sync failed',
        details: String(error),
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}

/**
 * Handle get configuration (GET /api/limitless/config)
 */
async function handleGetConfig(env: Env): Promise<Response> {
  const config = {
    configured: !!env.LIMITLESS_API_KEY,
    defaultMaxAgeHours: 24,
    defaultIncludeAudio: false,
  };

  return new Response(JSON.stringify(config), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Extract API key from request headers
 */
function extractAPIKey(request: Request): string | null {
  const authHeader = request.headers.get('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.substring(7);
  }

  const apiKeyHeader = request.headers.get('X-API-Key');
  if (apiKeyHeader) {
    return apiKeyHeader;
  }

  return null;
}

/**
 * Verify API key
 */
function verifyAPIKey(apiKey: string, env: Env): boolean {
  // Check against MONITORING_API_KEY (for sync operations)
  if (env.MONITORING_API_KEY && apiKey === env.MONITORING_API_KEY) {
    return true;
  }

  // Check against ADMIN_API_KEY (for config operations)
  if (env.ADMIN_API_KEY && apiKey === env.ADMIN_API_KEY) {
    return true;
  }

  // Check against legacy ASSISTANT_API_KEY
  if (env.ASSISTANT_API_KEY && apiKey === env.ASSISTANT_API_KEY) {
    return true;
  }

  return false;
}

/**
 * Scheduled sync handler for cron triggers
 * This can be called from the main cron handler
 */
export async function scheduledLimitlessSync(env: Env): Promise<void> {
  const limitlessApiKey = env.LIMITLESS_API_KEY;
  if (!limitlessApiKey) {
    safeLog.warn('[Limitless Sync] LIMITLESS_API_KEY not configured, skipping scheduled sync');
    return;
  }

  // Get list of users to sync (this would need to be configured)
  // For now, we'll skip automatic sync and require manual triggers
  safeLog.info('[Limitless Sync] Scheduled sync not configured, use manual trigger instead');
}
