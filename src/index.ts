/**
 * Cloudflare Workers Hub
 *
 * Orchestrator 拡張の統合入口
 * - Webhook 受信・正規化
 * - Workers AI による軽量応答
 * - Claude Orchestrator への転送
 */

import { Env } from './types';
import { CommHubAdapter } from './adapters/commhub';
import { performStartupCheck } from './utils/secrets-validator';
import { safeLog } from './utils/log-sanitizer';

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

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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

    // Initialize service role KV mappings (idempotent, runs once per isolate)
    if (!serviceRoleMappingsInitialized) {
      try {
        await ensureServiceRoleMappings(env);
      } catch (e) {
        safeLog.error('[Init] Service role mapping failed', { error: String(e) });
      }
      serviceRoleMappingsInitialized = true;
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // Health check endpoint
    if (path === '/health' || path === '/') {
      return handleHealthCheck(request, env);
    }

    // Metrics endpoint
    if (path === '/metrics') {
      return handleMetrics(request, env);
    }

    // Queue API endpoints (for AI Assistant Daemon)
    if (path.startsWith('/api/queue') || path.startsWith('/api/result')) {
      return handleQueueAPI(request, env, path);
    }

    // Memory API endpoints (for persistent conversation history)
    if (path.startsWith('/api/memory')) {
      return handleMemoryAPI(request, env, path);
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

    // Limitless API endpoints (for Pendant voice recording sync)
    if (path.startsWith('/api/limitless')) {
      // Webhook endpoint for iOS Shortcuts
      if (path === '/api/limitless/webhook-sync' && request.method === 'POST') {
        return handleLimitlessWebhook(request, env);
      }
      // Other Limitless API endpoints
      return handleLimitlessAPI(request, env, path);
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
      return handleWebhook(request, env);
    }

    // 404 for unknown paths
    return new Response('Not found', { status: 404 });
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    return handleScheduled(controller, env, ctx);
  },
};
