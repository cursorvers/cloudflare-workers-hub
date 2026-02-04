/**
 * Memory API for Conversation History
 *
 * Provides endpoints for persistent conversation management:
 * - Get conversation context
 * - Get conversation history
 * - Save conversation messages
 * - Manage user preferences
 * - Cleanup old conversations
 */

import { Env } from '../types';
import memoryHandler, { ConversationMessage, UserPreferences } from './memory';
import { safeLog, maskUserId } from '../utils/log-sanitizer';
import { checkRateLimit, createRateLimitResponse } from '../utils/rate-limiter';
import { verifyAPIKey, authorizeUserAccess } from '../utils/api-auth';
import { validateRequestBody, validatePathParameter } from '../schemas/validation-helper';
import { ConversationMessageSchema, UserPreferencesSchema } from '../schemas/memory';
import { UserIdPathSchema, ChannelPathSchema } from '../schemas/path-params';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

// ─── Shared helpers ──────────────────────────────────────────────────

/** Validate userId and verify authorization. Returns userId or an error Response. */
async function authorizeUserId(
  request: Request,
  env: Env,
  userId: string,
  endpoint: string,
): Promise<{ userId: string } | { response: Response }> {
  const validation = validatePathParameter(userId, UserIdPathSchema, 'userId', endpoint);
  if (!validation.success) {
    return { response: validation.response };
  }

  if (!await authorizeUserAccess(request, userId, env)) {
    safeLog.warn('[Memory API] Unauthorized access attempt', {
      endpoint,
      requestedUserId: maskUserId(userId),
    });
    return { response: new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: JSON_HEADERS }) };
  }

  return { userId };
}

/** Parse and validate optional channel query parameter. */
function parseChannelParam(url: URL, endpoint: string): { channel?: string } | { response: Response } {
  const channelParam = url.searchParams.get('channel');
  if (!channelParam) return {};

  const channelValidation = validatePathParameter(channelParam, ChannelPathSchema, 'channel', endpoint);
  if (!channelValidation.success) {
    return { response: channelValidation.response };
  }
  return { channel: channelValidation.data };
}

// ─── Route handlers ──────────────────────────────────────────────────

async function handleGetContext(request: Request, env: Env, rawUserId: string): Promise<Response> {
  const auth = await authorizeUserId(request, env, rawUserId, '/api/memory/context/:userId');
  if ('response' in auth) return auth.response;

  const url = new URL(request.url);
  const channelResult = parseChannelParam(url, '/api/memory/context/:userId');
  if ('response' in channelResult) return channelResult.response;

  const maxTokensParam = parseInt(url.searchParams.get('maxTokens') || '2000', 10);
  const maxTokens = Math.min(Math.max(maxTokensParam, 100), 4000);

  const context = await memoryHandler.getConversationContext(env, auth.userId, channelResult.channel, maxTokens);
  return new Response(JSON.stringify({ context, userId: auth.userId }), { headers: JSON_HEADERS });
}

async function handleGetHistory(request: Request, env: Env, rawUserId: string): Promise<Response> {
  const auth = await authorizeUserId(request, env, rawUserId, '/api/memory/history/:userId');
  if ('response' in auth) return auth.response;

  const url = new URL(request.url);
  const channelResult = parseChannelParam(url, '/api/memory/history/:userId');
  if ('response' in channelResult) return channelResult.response;

  const limitParam = parseInt(url.searchParams.get('limit') || '20', 10);
  const limit = Math.min(Math.max(limitParam, 1), 100);

  const history = await memoryHandler.getRecentConversations(env, auth.userId, channelResult.channel, limit);
  return new Response(JSON.stringify({ history, count: history.length }), { headers: JSON_HEADERS });
}

async function handleSaveMessage(request: Request, env: Env): Promise<Response> {
  const validation = await validateRequestBody(request, ConversationMessageSchema, '/api/memory/save');
  if (!validation.success) return validation.response;

  const message = validation.data as ConversationMessage;

  if (!await authorizeUserAccess(request, message.user_id, env)) {
    safeLog.warn('[Memory API] Unauthorized access attempt', {
      endpoint: '/save',
      requestedUserId: maskUserId(message.user_id),
    });
    return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: JSON_HEADERS });
  }

  await memoryHandler.saveConversation(env, message);
  return new Response(JSON.stringify({ success: true }), { headers: JSON_HEADERS });
}

async function handleGetPreferences(request: Request, env: Env, rawUserId: string): Promise<Response> {
  const auth = await authorizeUserId(request, env, rawUserId, '/api/memory/preferences/:userId');
  if ('response' in auth) return auth.response;

  const prefs = await memoryHandler.getUserPreferences(env, auth.userId);
  return new Response(JSON.stringify({ preferences: prefs }), { headers: JSON_HEADERS });
}

async function handleSavePreferences(request: Request, env: Env): Promise<Response> {
  const validation = await validateRequestBody(request, UserPreferencesSchema, '/api/memory/preferences');
  if (!validation.success) return validation.response;

  const prefs = validation.data as UserPreferences;

  if (!await authorizeUserAccess(request, prefs.user_id, env)) {
    safeLog.warn('[Memory API] Unauthorized access attempt', {
      endpoint: '/preferences (POST)',
      requestedUserId: maskUserId(prefs.user_id),
    });
    return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: JSON_HEADERS });
  }

  await memoryHandler.saveUserPreferences(env, prefs);
  return new Response(JSON.stringify({ success: true }), { headers: JSON_HEADERS });
}

// ─── Main router ─────────────────────────────────────────────────────

export async function handleMemoryAPI(request: Request, env: Env, path: string): Promise<Response> {
  if (!verifyAPIKey(request, env, 'memory')) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: JSON_HEADERS });
  }

  const apiKey = request.headers.get('X-API-Key') || 'unknown';
  const clientId = `key:${apiKey.substring(0, 8)}`;
  const rateLimitResult = await checkRateLimit(request, env, clientId);
  if (!rateLimitResult.allowed) {
    safeLog.warn('[Memory API] Rate limit exceeded', { clientId: clientId.substring(0, 12) });
    return createRateLimitResponse(rateLimitResult);
  }

  // GET /api/memory/context/:userId
  const contextMatch = path.match(/^\/api\/memory\/context\/([^/]+)$/);
  if (contextMatch && request.method === 'GET') {
    return handleGetContext(request, env, contextMatch[1]);
  }

  // GET /api/memory/history/:userId
  const historyMatch = path.match(/^\/api\/memory\/history\/([^/]+)$/);
  if (historyMatch && request.method === 'GET') {
    return handleGetHistory(request, env, historyMatch[1]);
  }

  // POST /api/memory/save
  if (path === '/api/memory/save' && request.method === 'POST') {
    return handleSaveMessage(request, env);
  }

  // GET /api/memory/preferences/:userId
  const prefsMatch = path.match(/^\/api\/memory\/preferences\/([^/]+)$/);
  if (prefsMatch && request.method === 'GET') {
    return handleGetPreferences(request, env, prefsMatch[1]);
  }

  // POST /api/memory/preferences
  if (path === '/api/memory/preferences' && request.method === 'POST') {
    return handleSavePreferences(request, env);
  }

  // POST /api/memory/cleanup
  if (path === '/api/memory/cleanup' && request.method === 'POST') {
    const deleted = await memoryHandler.cleanupOldConversations(env);
    return new Response(JSON.stringify({ success: true, deleted }), { headers: JSON_HEADERS });
  }

  return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: JSON_HEADERS });
}
