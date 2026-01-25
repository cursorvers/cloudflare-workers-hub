/**
 * Cloudflare Workers Hub
 *
 * Orchestrator 拡張の統合入口
 * - Webhook 受信・正規化
 * - Workers AI による軽量応答
 * - Claude Orchestrator への転送
 */

import { Env, WebhookEvent, NormalizedEvent } from './types';
import { CommHubAdapter } from './adapters/commhub';
import slackHandler, { SlackEvent, handleChallenge, postMessage as slackPostMessage } from './handlers/slack';
import discordHandler, { DiscordInteraction, isPing, handlePing } from './handlers/discord';
import clawdbotHandler, { ClawdBotMessage } from './handlers/clawdbot';
import { broadcastNotification, notifications } from './handlers/notifications';
import { metricsCollector, featureFlags, rollbackManager } from './utils/monitoring';
import { captureException, addBreadcrumb } from './utils/sentry';
import { performStartupCheck } from './utils/secrets-validator';
import { checkRateLimit, createRateLimitResponse, addRateLimitHeaders } from './utils/rate-limiter';
import { safeLog, maskUserId } from './utils/log-sanitizer';
import {
  telegramHandler,
  whatsappHandler,
  TelegramUpdate,
  WhatsAppWebhook,
  verifyTelegramSignature,
  verifyWhatsAppSignature,
} from './handlers/channels';
import memoryHandler, { ConversationMessage, UserPreferences } from './handlers/memory';
import cronHandler, { ScheduledTask, CreateTaskInput, UpdateTaskInput } from './handlers/cron';
import { registerDaemon, updateHeartbeat, getDaemonHealth, DaemonRegistration, DaemonHeartbeat } from './handlers/daemon';

import { handleQueueAPI, verifyAPIKey, authorizeUserAccess, hashAPIKey } from './handlers/queue';
import { handleHealthCheck, handleMetrics } from './handlers/health';
import { handleMemoryAPI } from './handlers/memory-api';
import { handleCronAPI } from './handlers/cron-api';
import { handleAdminAPI } from './handlers/admin-api';
import { handleDaemonAPI } from './handlers/daemon-api';
import { isSimpleQuery, handleWithWorkersAI } from './ai';
import { generateEventId, detectSource } from './router';

export type { Env };

// Initialize CommHub Adapter (KV will be set on first request)
const commHub = new CommHubAdapter();

// Startup check flag (Cloudflare Workers are stateless, so check on first request)
let startupCheckDone = false;
let commHubInitialized = false;


async function normalizeEvent(
  source: WebhookEvent['source'],
  payload: unknown
): Promise<NormalizedEvent> {
  const id = generateEventId();
  let content = '';
  let type = 'unknown';
  let metadata: Record<string, unknown> = {};

  switch (source) {
    case 'slack':
      const slackPayload = payload as { event?: { text?: string; type?: string; user?: string } };
      content = slackPayload.event?.text || '';
      type = slackPayload.event?.type || 'message';
      metadata = { user: slackPayload.event?.user };
      break;

    case 'discord':
      const discordPayload = payload as { content?: string; author?: { id: string } };
      content = discordPayload.content || '';
      type = 'message';
      metadata = { author: discordPayload.author?.id };
      break;

    case 'clawdbot':
      const clawdPayload = payload as { message?: string; channel?: string; user?: string };
      content = clawdPayload.message || '';
      type = 'customer_message';
      metadata = { channel: clawdPayload.channel, user: clawdPayload.user };
      break;

    default:
      content = JSON.stringify(payload);
      type = 'raw';
  }

  return {
    id,
    source,
    type,
    content,
    metadata,
    requiresOrchestrator: !isSimpleQuery(content),
  };
}

async function forwardToOrchestrator(event: NormalizedEvent): Promise<Response> {
  // Use CommHub Adapter to process and forward
  const response = await commHub.processEvent(event);

  return new Response(JSON.stringify({
    status: response.status,
    eventId: event.id,
    message: response.message,
    estimatedCompletion: response.estimatedCompletion,
  }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

async function handleSlackWebhook(request: Request, env: Env): Promise<Response> {
  const body = await request.text();
  let payload: SlackEvent;

  try {
    payload = JSON.parse(body);
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  // Handle Slack URL verification challenge
  if (payload.type === 'url_verification') {
    const response = handleChallenge(payload);
    return new Response(JSON.stringify(response), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Verify Slack signature (if signing secret is configured)
  if (env.SLACK_SIGNING_SECRET) {
    const signature = request.headers.get('x-slack-signature');
    const timestamp = request.headers.get('x-slack-request-timestamp');
    const isValid = await slackHandler.verifySlackSignature(signature, timestamp, body, env.SLACK_SIGNING_SECRET);
    if (!isValid) {
      safeLog.warn('[Slack] Invalid signature');
      return new Response('Invalid signature', { status: 401 });
    }
  }

  // Normalize and process event
  const event = slackHandler.normalizeSlackEvent(payload);
  if (!event) {
    return new Response('OK', { status: 200 });
  }

  // Ignore bot messages to prevent loops
  if (payload.event?.user === undefined || payload.event?.bot_id) {
    return new Response('OK', { status: 200 });
  }

  const channel = payload.event?.channel;
  const threadTs = payload.event?.thread_ts || payload.event?.ts;

  // Check channel rules
  const channelName = event.metadata.channelName as string;
  if (slackHandler.requiresConsensus(channelName)) {
    await broadcastNotification(
      notifications.approvalRequired(event.content, `Slack #${channelName}`),
      { slackWebhookUrl: undefined }
    );
  }

  // Handle simple queries with Workers AI and reply
  const isSimple = isSimpleQuery(event.content);
  if (isSimple && env.SLACK_BOT_TOKEN && channel) {
    const aiResponse = await handleWithWorkersAI(env, event);
    await slackPostMessage(channel, aiResponse, env.SLACK_BOT_TOKEN, threadTs);
    return new Response('OK', { status: 200 });
  }

  // Complex queries: acknowledge and forward to Orchestrator
  if (env.SLACK_BOT_TOKEN && channel) {
    await slackPostMessage(
      channel,
      '処理中です... Orchestrator に転送しました。',
      env.SLACK_BOT_TOKEN,
      threadTs
    );
  }

  return handleGenericWebhook(event, env);
}

async function handleDiscordWebhook(request: Request, env: Env): Promise<Response> {
  const body = await request.text();

  // Verify Discord signature FIRST (required by Discord)
  if (env.DISCORD_PUBLIC_KEY) {
    const signature = request.headers.get('x-signature-ed25519');
    const timestamp = request.headers.get('x-signature-timestamp');
    const isValid = await discordHandler.verifyDiscordSignature(signature, timestamp, body, env.DISCORD_PUBLIC_KEY);
    if (!isValid) {
      return new Response('Invalid signature', { status: 401 });
    }
  }

  let payload: DiscordInteraction;
  try {
    payload = JSON.parse(body);
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  // Handle Discord PING for verification
  if (isPing(payload)) {
    return new Response(JSON.stringify(handlePing()), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Normalize and process event
  const event = discordHandler.normalizeDiscordEvent(payload);
  if (!event) {
    return new Response(JSON.stringify({ type: 1 }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // For Discord, return deferred response and process async
  const deferredResponse = discordHandler.createDeferredResponse();

  // Process in background (don't await)
  handleGenericWebhook(event, env).catch((err) => safeLog.error('[Discord] Background processing error', { error: String(err) }));

  return new Response(JSON.stringify(deferredResponse), {
    headers: { 'Content-Type': 'application/json' },
  });
}

async function handleGenericWebhook(event: NormalizedEvent, env: Env): Promise<Response> {
  // Log event without PII (content is not logged, only length)
  safeLog.log(`[Event] ${event.id}`, { source: event.source, type: event.type, contentLength: event.content.length });

  // Cache event metadata (if KV is available)
  if (env.CACHE) {
    await env.CACHE.put(`event:${event.id}`, JSON.stringify(event), { expirationTtl: 3600 });
  }

  if (!event.requiresOrchestrator) {
    // Handle simple queries with Workers AI
    const response = await handleWithWorkersAI(env, event);
    return new Response(JSON.stringify({
      eventId: event.id,
      response,
      handledBy: 'workers-ai',
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Forward complex requests to Orchestrator
  return forwardToOrchestrator(event);
}

async function handleClawdBotWebhook(request: Request, env: Env): Promise<Response> {
  let payload: unknown;

  try {
    payload = await request.json();
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  // Validate payload
  if (!clawdbotHandler.validatePayload(payload)) {
    return new Response('Invalid ClawdBot payload', { status: 400 });
  }

  const clawdPayload = payload as ClawdBotMessage;
  const event = clawdbotHandler.normalizeClawdBotEvent(clawdPayload);

  // Check if FAQ can be handled by Workers AI
  const faqCategory = event.metadata.faqCategory as string | null;
  if (faqCategory && !event.metadata.needsEscalation) {
    // Generate FAQ response with Workers AI
    const prompt = clawdbotHandler.generateFAQPrompt(faqCategory, event.content);

    try {
      const response = await (env.AI.run as (model: string, input: unknown) => Promise<unknown>)(
        '@cf/meta/llama-3.1-8b-instruct',
        {
          messages: [
            { role: 'system', content: 'あなたは丁寧なカスタマーサポート担当です。日本語で簡潔に回答してください。' },
            { role: 'user', content: prompt },
          ],
          max_tokens: 256,
        }
      );

      const aiResponse = (response as { response: string }).response;
      const formattedResponse = clawdbotHandler.formatResponse(clawdPayload.channel, aiResponse);

      return new Response(JSON.stringify({
        success: true,
        messageId: event.id,
        response: formattedResponse,
        handledBy: 'workers-ai',
        followUpRequired: false,
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      safeLog.error('[FAQ] Workers AI error', { error: String(error) });
      // Fall through to Orchestrator
    }
  }

  // Escalations or complex requests go to Orchestrator
  if (event.metadata.needsEscalation) {
    // Notify about escalation
    await broadcastNotification(
      notifications.approvalRequired(
        `Customer escalation from ${clawdPayload.channel}`,
        event.content.substring(0, 100)
      ),
      { slackWebhookUrl: undefined }
    );
  }

  return handleGenericWebhook(event, env);
}

async function handleTelegramWebhook(request: Request, env: Env): Promise<Response> {
  // Verify Telegram signature if secret token is configured
  if (env.TELEGRAM_SECRET_TOKEN) {
    const secretTokenHeader = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
    if (!verifyTelegramSignature(secretTokenHeader, env.TELEGRAM_SECRET_TOKEN)) {
      safeLog.warn('[Telegram] Invalid or missing secret token');
      return new Response('Unauthorized', { status: 401 });
    }
  }

  let payload: TelegramUpdate;

  try {
    payload = await request.json() as TelegramUpdate;
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  if (!telegramHandler.validateTelegramUpdate(payload)) {
    return new Response('Invalid Telegram update', { status: 400 });
  }

  // Normalize to ClawdBot format
  const event = telegramHandler.normalizeTelegramEvent(payload);
  if (!event) {
    return new Response('OK', { status: 200 });
  }

  // Process through ClawdBot handler logic
  const faqCategory = clawdbotHandler.detectFAQCategory(event.content);
  const needsEscalation = clawdbotHandler.requiresEscalation(event.content);

  if (faqCategory && !needsEscalation) {
    // Handle FAQ with Workers AI
    const prompt = clawdbotHandler.generateFAQPrompt(faqCategory, event.content);
    try {
      const response = await (env.AI.run as (model: string, input: unknown) => Promise<unknown>)(
        '@cf/meta/llama-3.1-8b-instruct',
        {
          messages: [
            { role: 'system', content: 'あなたは丁寧なカスタマーサポート担当です。日本語で簡潔に回答してください。' },
            { role: 'user', content: prompt },
          ],
          max_tokens: 256,
        }
      );

      const aiResponse = (response as { response: string }).response;
      const chatId = event.metadata.chatId as number;

      if (env.TELEGRAM_BOT_TOKEN && chatId) {
        await telegramHandler.sendTelegramMessage(
          chatId,
          aiResponse,
          env.TELEGRAM_BOT_TOKEN,
          event.metadata.messageId as number | undefined
        );
      }

      return new Response('OK', { status: 200 });
    } catch (error) {
      safeLog.error('[Telegram FAQ] error', { error: String(error) });
    }
  }

  // Forward to Orchestrator for complex requests
  return handleGenericWebhook(event, env);
}

async function handleWhatsAppWebhook(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  // Handle webhook verification (GET request)
  if (request.method === 'GET') {
    const mode = url.searchParams.get('hub.mode');
    const token = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge');

    if (env.WHATSAPP_VERIFY_TOKEN) {
      const verifyResponse = whatsappHandler.verifyWebhook(mode, token, challenge, env.WHATSAPP_VERIFY_TOKEN);
      if (verifyResponse) return verifyResponse;
    }
    return new Response('Forbidden', { status: 403 });
  }

  // Handle webhook events (POST request)
  // Read body as text first for signature verification
  const body = await request.text();

  // Verify WhatsApp HMAC signature if app secret is configured
  if (env.WHATSAPP_APP_SECRET) {
    const signatureHeader = request.headers.get('X-Hub-Signature-256');
    const isValid = await verifyWhatsAppSignature(signatureHeader, body, env.WHATSAPP_APP_SECRET);
    if (!isValid) {
      safeLog.warn('[WhatsApp] Invalid HMAC signature');
      return new Response('Unauthorized', { status: 401 });
    }
  }

  let payload: WhatsAppWebhook;

  try {
    payload = JSON.parse(body) as WhatsAppWebhook;
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  if (!whatsappHandler.validateWhatsAppWebhook(payload)) {
    return new Response('Invalid WhatsApp webhook', { status: 400 });
  }

  // Extract and process messages
  const messages = whatsappHandler.extractMessages(payload);

  for (const { message, contact, phoneNumberId } of messages) {
    const event = whatsappHandler.normalizeWhatsAppEvent(message, contact, phoneNumberId);
    if (!event) continue;

    // Process through ClawdBot handler logic
    const faqCategory = clawdbotHandler.detectFAQCategory(event.content);
    const needsEscalation = clawdbotHandler.requiresEscalation(event.content);

    if (faqCategory && !needsEscalation) {
      // Handle FAQ with Workers AI
      const prompt = clawdbotHandler.generateFAQPrompt(faqCategory, event.content);
      try {
        const response = await (env.AI.run as (model: string, input: unknown) => Promise<unknown>)(
          '@cf/meta/llama-3.1-8b-instruct',
          {
            messages: [
              { role: 'system', content: 'あなたは丁寧なカスタマーサポート担当です。日本語で簡潔に回答してください。' },
              { role: 'user', content: prompt },
            ],
            max_tokens: 256,
          }
        );

        const aiResponse = (response as { response: string }).response;

        if (env.WHATSAPP_ACCESS_TOKEN && phoneNumberId) {
          await whatsappHandler.sendWhatsAppMessage(
            message.from,
            aiResponse,
            phoneNumberId,
            env.WHATSAPP_ACCESS_TOKEN,
            message.id
          );
        }
      } catch (error) {
        safeLog.error('[WhatsApp FAQ] error', { error: String(error) });
      }
    } else {
      // Forward to Orchestrator for complex requests
      await handleGenericWebhook(event, env);
    }
  }

  return new Response('OK', { status: 200 });
}

async function handleWebhook(request: Request, env: Env): Promise<Response> {
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
  const rateLimitResult = await checkRateLimit(env, source, clientIp);
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
      response = await handleDiscordWebhook(request, env);
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

// ============================================

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
};
