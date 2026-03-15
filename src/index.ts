/**
 * Cloudflare Workers Hub
 *
 * Orchestrator 拡張の統合入口
 * - Webhook 受信・正規化
 * - Workers AI による軽量応答
 * - Claude Orchestrator への転送
 */

import { withSentry, instrumentDurableObjectWithSentry } from '@sentry/cloudflare';
import { Env } from './types';
import { CommHubAdapter } from './adapters/commhub';
import { performStartupCheck } from './utils/secrets-validator';
import { safeLog } from './utils/log-sanitizer';
import { getDeployTarget, isCanaryWriteEnabled, maybeBlockCanaryWrite } from './utils/canary-write-gate';
import { createSentryConfig } from './utils/sentry';
import { buildCorsHeaders, isOriginAllowed } from './utils/cors';

// Durable Objects — wrapped with Sentry for error monitoring
import { TaskCoordinator as _TaskCoordinator } from './durable-objects/task-coordinator';
import { CockpitWebSocket as _CockpitWebSocket } from './durable-objects/cockpit-websocket';
import { SystemEvents as _SystemEvents } from './durable-objects/system-events';
import { RateLimiter as _RateLimiter } from './durable-objects/rate-limiter';
import { RunCoordinator as _RunCoordinator } from './durable-objects/run-coordinator';
import { AutopilotCoordinator as _AutopilotCoordinator } from './fugue/autopilot/durable-objects/autopilot-coordinator';
import { SafetySentinel as _SafetySentinel } from './fugue/autopilot/durable-objects/safety-sentinel';

const sentryDOConfig = (env: Env) => createSentryConfig(env);

export const TaskCoordinator = instrumentDurableObjectWithSentry(sentryDOConfig, _TaskCoordinator);
export const CockpitWebSocket = instrumentDurableObjectWithSentry(sentryDOConfig, _CockpitWebSocket);
export const SystemEvents = instrumentDurableObjectWithSentry(sentryDOConfig, _SystemEvents);
export const RateLimiter = instrumentDurableObjectWithSentry(sentryDOConfig, _RateLimiter);
export const RunCoordinator = instrumentDurableObjectWithSentry(sentryDOConfig, _RunCoordinator);
export const AutopilotCoordinator = instrumentDurableObjectWithSentry(sentryDOConfig, _AutopilotCoordinator);
export const SafetySentinel = instrumentDurableObjectWithSentry(sentryDOConfig, _SafetySentinel);

// Handlers
import { ensureServiceRoleMappings } from './handlers/initialization';
import { initGenericWebhook } from './handlers/generic-webhook';
import { handleWebhook } from './handlers/webhook-router';
import { handleWhatsAppWebhook } from './handlers/channels/whatsapp';
import { handleQueueAPI } from './handlers/queue';
import { handleHealthCheck, handleMetrics } from './handlers/health';
import { handleMemoryAPI } from './handlers/memory-api';
import { handleCronAPI } from './handlers/cron-api';
import { handleAdminAPI } from './handlers/admin-api';
import { handleDaemonAPI } from './handlers/daemon-api';
import { handleLimitlessAPI } from './handlers/limitless-api';
import { handleLimitlessWebhook } from './handlers/limitless-webhook';
import { handleScheduled } from './handlers/scheduled';
import { handleCockpitAPI } from './handlers/cockpit-api';
import { handleOrchestrateAPI } from './handlers/orchestrate-api';
import { handleAdvisorAPI } from './handlers/strategic-advisor-api';
import { handleUsageAPI } from './handlers/usage-api';
import { handleGoalPlannerAPI } from './handlers/goal-planner';
import { handlePushQueueBatch } from './handlers/push-queue-consumer';
import { handleAutopilotAPI } from './fugue/autopilot/handlers/autopilot-api';
import { handleFinanceAutomationAPI } from './handlers/finance-automation-api';

// Extracted modules
import { COCKPIT_HTML } from './static/cockpit-html';
import { handleServiceWorker } from './static/service-worker';

export type { Env };

// Cache version for schema changes (update when KV schema changes)
const CACHE_VERSION = 'v1';

// Initialize CommHub Adapter (KV will be set on first request)
const commHub = new CommHubAdapter();

// Initialize generic webhook handler with shared dependencies
initGenericWebhook(commHub, CACHE_VERSION);

// Startup check flags (Cloudflare Workers are stateless, so check on first request)
let startupCheckDone = false;
let commHubInitialized = false;
let serviceRoleMappingsInitialized = false;

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		  const url = new URL(request.url);
		  const workerOrigin = url.origin;
		  const path = url.pathname;
	
		  const deployTarget = getDeployTarget(env);
		  const canaryWriteEnabled = isCanaryWriteEnabled(env);
		  const blocked = maybeBlockCanaryWrite(request, env);
		  if (blocked) return blocked;

    // Perform startup secrets validation once
    if (!startupCheckDone) {
      performStartupCheck(env);
      startupCheckDone = true;
    }

    // Initialize CommHub with KV for queue-based orchestration
    if (!commHubInitialized && env.CACHE) {
      commHub.setKV(env.CACHE);
      commHubInitialized = true;
    }
    if (env.DB) {
      commHub.setDB(env.DB);
    }

    // Initialize service role KV mappings (idempotent, runs once per isolate)
    if (!serviceRoleMappingsInitialized) {
	    // If canary is in read-only mode, skip any initialization that could write to D1/KV.
	    if (!(deployTarget === 'canary' && !canaryWriteEnabled)) {
	      try {
	        await ensureServiceRoleMappings(env);
	      } catch (e) {
	        safeLog.error('[Init] Service role mapping failed', { error: String(e) });
	      }
	    }
      serviceRoleMappingsInitialized = true;
	    }

    // Sentry test event endpoint (admin only, verifies Sentry connectivity)
    if (path === '/api/sentry/test' && request.method === 'POST') {
      const { verifyAPIKey } = await import('./utils/api-auth');
      if (!verifyAPIKey(request, env, 'admin')) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401, headers: { 'Content-Type': 'application/json' },
        });
      }
      const { captureMessage, captureException } = await import('./utils/sentry');
      try {
        captureMessage(`[Sentry Test] Workers Hub connectivity check at ${new Date().toISOString()}`, 'info');
        captureException(new Error('[Sentry Test] Deliberate test error from Workers Hub'), {
          source: 'sentry-test-endpoint',
          deployTarget: env.DEPLOY_TARGET,
          environment: env.ENVIRONMENT,
        });
        return new Response(JSON.stringify({
          success: true,
          message: 'Test event and test error sent to Sentry',
          dsn: env.SENTRY_DSN ? 'configured' : 'missing',
          environment: env.DEPLOY_TARGET || env.ENVIRONMENT,
          release: env.SENTRY_RELEASE || 'orchestrator-hub@unknown',
        }), { headers: { 'Content-Type': 'application/json' } });
      } catch (error) {
        return new Response(JSON.stringify({
          success: false,
          error: String(error),
        }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      }
    }

    // Health check endpoint
    if (path === '/health') {
      return handleHealthCheck(request, env);
    }

    // Root redirect to Cockpit PWA
    if (path === '/') {
      return Response.redirect(`${url.origin}/cockpit`, 302);
    }

    // Metrics endpoint
    if (path === '/metrics') {
      return handleMetrics(request, env);
    }

    // Cockpit PWA (static HTML)
    if (path === '/cockpit' || path === '/cockpit/') {
      const html = COCKPIT_HTML;
      return new Response(html, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    // Service Worker (for PWA Push Notifications)
    if (path === '/sw.js') {
      return handleServiceWorker();
    }

    // Queue API endpoints (for AI Assistant Daemon)
    if (path.startsWith('/api/queue') || path.startsWith('/api/result')) {
      try {
        return await handleQueueAPI(request, env, path);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const stack = e instanceof Error ? e.stack : undefined;
        const apiKey = request.headers.get('X-API-Key') || request.headers.get('x-api-key') || 'missing';
        safeLog.error('[Queue] Unhandled error:', {
          message: msg,
          stack,
          path,
          method: request.method,
          hasXApiKey: request.headers.has('X-API-Key'),
          hasLowercaseApiKey: request.headers.has('x-api-key'),
          apiKeyPrefix: apiKey !== 'missing' ? apiKey.substring(0, 8) : 'missing',
        });
        return new Response(JSON.stringify({ error: 'Internal error' }), {
          status: 500, headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    // Memory API endpoints (for persistent conversation history)
    if (path.startsWith('/api/memory')) {
      return handleMemoryAPI(request, env, path);
    }

      // freee OAuth (/api/freee/auth, /api/freee/callback)
      if (path === '/api/freee/auth' || path === '/api/freee/callback') {
        const { handleFreeeOAuth } = await import('./handlers/freee-oauth');
        const freeeResponse = await handleFreeeOAuth(request, env, path);
        if (freeeResponse) return freeeResponse;
      }


    // Receipt API endpoints (/api/receipts/*)
    if (path === '/api/receipts' || path.startsWith('/api/receipts/')) {
      const { handleReceiptAPI } = await import('./handlers/receipt-admin-api');
      return handleReceiptAPI(request, env, path);
    }

    // Cron API endpoints (for scheduled task management)
    if (path.startsWith('/api/cron')) {
      return handleCronAPI(request, env, path);
    }

    // Admin API endpoints (for API key management)
    if (path.startsWith('/api/admin')) {
      return handleAdminAPI(request, env, path);
    }


    // Daemon Health API endpoints (for monitoring active daemons)
    if (path.startsWith('/api/daemon')) {
      return handleDaemonAPI(request, env, path);
    }

    // AI Usage API endpoints (for FUGUE agent usage monitoring)
    if (path.startsWith('/api/usage')) {
      return handleUsageAPI(request, env, path);
    }

    // Goal Planner API endpoints (FUGUE Evolution Phase 0.5)
    if (path.startsWith('/api/goals')) {
      return handleGoalPlannerAPI(request, env, path);
    }

    // Limitless API endpoints (for Pendant voice recording sync)
    if (path.startsWith('/api/limitless')) {
      // Webhook endpoint for iOS Shortcuts
      if (path === '/api/limitless/webhook-sync' && request.method === 'POST') {
        return handleLimitlessWebhook(request, env);
      }
      // Phase 1: Highlight trigger endpoint (iOS Shortcut timestamp mark)
      // Accept both GET and POST (iOS Shortcut compatibility)
      if (path === '/api/limitless/highlight-trigger' && (request.method === 'GET' || request.method === 'POST')) {
        const { handleHighlightTrigger } = await import('./handlers/limitless-highlight');
        return handleHighlightTrigger(request, env);
      }
      // Other Limitless API endpoints
      return handleLimitlessAPI(request, env, path);
    }

    // Strategic Advisor API endpoints (for FUGUE insights) - with CORS
	    if (path.startsWith('/api/advisor')) {
	      const origin = request.headers.get('Origin') || '';
      const corsHeaders = buildCorsHeaders(origin, workerOrigin);

      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders });
      }

      if (request.method === 'POST' && origin && !isOriginAllowed(origin, workerOrigin)) {
        safeLog.warn('[Advisor API] CSRF: rejected cross-origin POST', { origin });
        return new Response(JSON.stringify({ error: 'Forbidden: Invalid origin' }), {
          status: 403, headers: { 'Content-Type': 'application/json' },
        });
      }

      const response = await handleAdvisorAPI(request, env, path);
      const newResponse = new Response(response.body, response);
      Object.entries(corsHeaders).forEach(([key, value]) => {
        newResponse.headers.set(key, value);
      });
      return newResponse;
    }

    // Orchestration API endpoints (FUGUE persistent runs)
    if (path.startsWith('/api/orchestrate') || path.startsWith('/api/runs') || path.startsWith('/api/approvals')) {
      return handleOrchestrateAPI(request, env, path, ctx);
    }

    // Autopilot API endpoints (FUGUE runtime safety management plane)
    if (path.startsWith('/api/autopilot')) {
      return handleAutopilotAPI(request, env, path);
    }

    // Finance automation control plane (Cursorvers finance backend + FUGUE compatibility)
    if (path.startsWith('/api/finance') || path.startsWith('/api/fugue/finance')) {
      return handleFinanceAutomationAPI(request, env, path);
    }

    // Cockpit API endpoints (for FUGUE monitoring) - with CORS
	    if (path.startsWith('/api/cockpit')) {
	      const origin = request.headers.get('Origin') || '';
      const corsHeaders = buildCorsHeaders(origin, workerOrigin, 'GET, POST, PUT, DELETE, OPTIONS');

      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders });
      }

      if (request.method === 'POST' && origin && !isOriginAllowed(origin, workerOrigin)) {
        safeLog.warn('[Cockpit API] CSRF: rejected cross-origin POST', { origin });
        return new Response(JSON.stringify({ error: 'Forbidden: Invalid origin' }), {
          status: 403, headers: { 'Content-Type': 'application/json' },
        });
      }

      const response = await handleCockpitAPI(request, env, path);
      const newResponse = new Response(response.body, response);
      Object.entries(corsHeaders).forEach(([key, value]) => {
        newResponse.headers.set(key, value);
      });
      return newResponse;
    }

    // Notification System API (SystemEvents DO)
    if (path.startsWith('/api/notifications')) {
      const { handleNotificationsAPI } = await import('./handlers/notifications-api');
      return handleNotificationsAPI(request, env, path, url, workerOrigin);
    }

    // WebSocket upgrade for Notifications (SystemEvents DO)
    if (path === '/api/notifications/ws' && request.headers.get('Upgrade') === 'websocket') {
      const { handleNotificationsWebSocket } = await import('./handlers/notifications-api');
      return handleNotificationsWebSocket(request, env, url);
    }

    // WebSocket upgrade for Cockpit (upgrade to DO)
    if (path === '/api/ws' && request.headers.get('Upgrade') === 'websocket') {
      const { handleCockpitWebSocket } = await import('./handlers/notifications-api');
      return handleCockpitWebSocket(request, env, url);
    }

    // Webhook endpoints
    if (path.startsWith('/webhook/')) {
      // Allow GET for WhatsApp webhook verification
      if (request.method === 'GET' && path.includes('/whatsapp')) {
        return handleWhatsAppWebhook(request, env);
      }
      if (request.method !== 'POST') {
        return new Response('Method not allowed', { status: 405 });
      }
      return handleWebhook(request, env, ctx);
    }

    // 404 for unknown paths
    return new Response('Not found', { status: 404 });
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    return handleScheduled(controller, env, ctx);
  },

  // Queue consumer (requires paid plan - Cloudflare Queues)
  // async queue(batch: MessageBatch, env: Env, ctx: ExecutionContext): Promise<void> {
  //   return handlePushQueueBatch(batch, env);
  // },
};

// Wrap worker with Sentry error monitoring
// DSN is set via `wrangler secret put SENTRY_DSN`
export default withSentry(
  (env: Env) => sentryDOConfig(env),
  worker
);
