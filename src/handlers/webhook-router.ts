/**
 * Webhook Router
 *
 * Central dispatcher for incoming webhooks:
 * - Rate limiting
 * - Feature flags / rollback checks
 * - Channel-specific routing
 * - Error handling with Sentry
 */

import { Env } from '../types';
import { detectSource } from '../router';
import { metricsCollector, featureFlags, rollbackManager } from '../utils/monitoring';
import { captureException, addBreadcrumb } from '../utils/sentry';
import { checkRateLimit, createRateLimitResponse, addRateLimitHeaders } from '../utils/rate-limiter';
import { safeLog, maskUserId } from '../utils/log-sanitizer';
import { normalizeEvent } from '../utils/event-normalizer';
import { handleGenericWebhook } from './generic-webhook';
import { handleSlackWebhook } from './slack';
import { handleDiscordWebhook } from './discord';
import { handleClawdBotWebhook } from './clawdbot';
import { handleTelegramWebhook } from './channels/telegram';
import { handleWhatsAppWebhook } from './channels/whatsapp';

export async function handleWebhook(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const source = detectSource(request);
  const url = new URL(request.url);
  const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;

  // Get client identifier for rate limiting (IP or forwarded header)
  const clientIp = request.headers.get('CF-Connecting-IP') ||
    request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ||
    'unknown';

  // Add Sentry breadcrumb for request tracking (sanitized)
  addBreadcrumb('webhook', `Incoming ${source} webhook`, {
    requestId,
    path: url.pathname,
    method: request.method,
  });

  // Start metrics tracking
  const metric = metricsCollector.startRequest(requestId, source, url.pathname, request.method);

  // Check rate limit
  const rateLimitResult = await checkRateLimit(request, env, clientIp);
  if (!rateLimitResult.allowed) {
    safeLog.warn(`[${requestId}] Rate limit exceeded for ${source}`, {
      clientIp: maskUserId(clientIp),
      remaining: rateLimitResult.remaining,
    });
    metricsCollector.endRequest(metric, 429, 'Rate limited');
    return createRateLimitResponse(rateLimitResult);
  }

  // Check feature flags
  if (!featureFlags.isChannelEnabled(source)) {
    metricsCollector.endRequest(metric, 503, 'Channel disabled');
    return new Response(JSON.stringify({
      error: 'Channel temporarily disabled',
      requestId,
    }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Check rollback status
  if (rollbackManager.shouldRollback(source)) {
    featureFlags.disableChannel(source);
    metricsCollector.endRequest(metric, 503, 'Auto-rollback triggered');
    return new Response(JSON.stringify({
      error: 'Channel auto-disabled due to errors',
      requestId,
    }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    let response: Response;

    // Use specialized handlers for each channel
    if (source === 'slack') {
      response = await handleSlackWebhook(request, env);
    } else if (source === 'discord') {
      response = await handleDiscordWebhook(request, env, ctx);
    } else if (source === 'telegram') {
      response = await handleTelegramWebhook(request, env);
    } else if (source === 'whatsapp') {
      response = await handleWhatsAppWebhook(request, env);
    } else if (source === 'clawdbot') {
      response = await handleClawdBotWebhook(request, env);
    } else {
      // Generic handler for other sources
      let payload: unknown;
      try {
        payload = await request.json();
      } catch {
        metricsCollector.endRequest(metric, 400, 'Invalid JSON');
        return new Response('Invalid JSON payload', { status: 400 });
      }

      const event = await normalizeEvent(source, payload);
      response = await handleGenericWebhook(event, env);
    }

    metricsCollector.endRequest(metric, response.status);
    // Add rate limit headers to successful responses
    return addRateLimitHeaders(response, rateLimitResult);
  } catch (error) {
    rollbackManager.recordError(source);
    metricsCollector.endRequest(metric, 500, String(error));
    // Use sanitized logging
    safeLog.error(`[${requestId}] Error:`, { error: String(error), source, path: url.pathname });

    // Capture exception to Sentry
    captureException(error instanceof Error ? error : new Error(String(error)), {
      requestId,
      source,
      path: url.pathname,
    });

    return new Response(JSON.stringify({
      error: 'Internal server error',
      requestId,
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
