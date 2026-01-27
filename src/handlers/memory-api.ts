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

export async function handleMemoryAPI(request: Request, env: Env, path: string): Promise<Response> {
  // Verify API Key with 'memory' scope
  if (!verifyAPIKey(request, env, 'memory')) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Rate limiting for Memory API (keyed on API key hash for client identification)
  const apiKey = request.headers.get('X-API-Key') || 'unknown';
  const clientId = `key:${apiKey.substring(0, 8)}`; // Use first 8 chars as identifier
  const rateLimitResult = await checkRateLimit(env, 'memory', clientId);
  if (!rateLimitResult.allowed) {
    safeLog.warn('[Memory API] Rate limit exceeded', { clientId: clientId.substring(0, 12) });
    return createRateLimitResponse(rateLimitResult);
  }

  // GET /api/memory/context/:userId - Get conversation context
  const contextMatch = path.match(/^\/api\/memory\/context\/([^/]+)$/);
  if (contextMatch && request.method === 'GET') {
    const userId = contextMatch[1];

    // SECURITY: Validate userId format
    const validation = validatePathParameter(userId, UserIdPathSchema, 'userId', '/api/memory/context/:userId');
    if (!validation.success) {
      return validation.response;
    }

    // SECURITY: Verify that the API key is authorized to access this userId
    if (!await authorizeUserAccess(request, userId, env)) {
      safeLog.warn('[Memory API] Unauthorized access attempt', {
        endpoint: '/context',
        requestedUserId: maskUserId(userId),
      });
      return new Response(JSON.stringify({ error: 'Forbidden' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const url = new URL(request.url);
    const channelParam = url.searchParams.get('channel');
    let channel: string | undefined = undefined;

    // SECURITY: Validate channel parameter if present
    if (channelParam) {
      const channelValidation = validatePathParameter(channelParam, ChannelPathSchema, 'channel', '/api/memory/context/:userId');
      if (!channelValidation.success) {
        return channelValidation.response;
      }
      channel = channelValidation.data;
    }

    const maxTokensParam = parseInt(url.searchParams.get('maxTokens') || '2000', 10);
    // Validate maxTokens is within bounds (100-4000)
    const maxTokens = Math.min(Math.max(maxTokensParam, 100), 4000);

    const context = await memoryHandler.getConversationContext(env, userId, channel, maxTokens);
    return new Response(JSON.stringify({ context, userId }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // GET /api/memory/history/:userId - Get conversation history
  const historyMatch = path.match(/^\/api\/memory\/history\/([^/]+)$/);
  if (historyMatch && request.method === 'GET') {
    const userId = historyMatch[1];

    // SECURITY: Validate userId format
    const validation = validatePathParameter(userId, UserIdPathSchema, 'userId', '/api/memory/history/:userId');
    if (!validation.success) {
      return validation.response;
    }

    // SECURITY: Verify that the API key is authorized to access this userId
    if (!await authorizeUserAccess(request, userId, env)) {
      safeLog.warn('[Memory API] Unauthorized access attempt', {
        endpoint: '/history',
        requestedUserId: maskUserId(userId),
      });
      return new Response(JSON.stringify({ error: 'Forbidden' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const url = new URL(request.url);
    const channelParam = url.searchParams.get('channel');
    let channel: string | undefined = undefined;

    // SECURITY: Validate channel parameter if present
    if (channelParam) {
      const channelValidation = validatePathParameter(channelParam, ChannelPathSchema, 'channel', '/api/memory/history/:userId');
      if (!channelValidation.success) {
        return channelValidation.response;
      }
      channel = channelValidation.data;
    }

    const limitParam = parseInt(url.searchParams.get('limit') || '20', 10);
    // Validate limit is within bounds (1-100)
    const limit = Math.min(Math.max(limitParam, 1), 100);

    const history = await memoryHandler.getRecentConversations(env, userId, channel, limit);
    return new Response(JSON.stringify({ history, count: history.length }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // POST /api/memory/save - Save conversation message
  if (path === '/api/memory/save' && request.method === 'POST') {
    const validation = await validateRequestBody(request, ConversationMessageSchema, '/api/memory/save');
    if (!validation.success) {
      return validation.response;
    }

    const message = validation.data as ConversationMessage;

    // SECURITY: Verify that the API key is authorized to save for this userId
    if (!await authorizeUserAccess(request, message.user_id, env)) {
      safeLog.warn('[Memory API] Unauthorized access attempt', {
        endpoint: '/save',
        requestedUserId: maskUserId(message.user_id),
      });
      return new Response(JSON.stringify({ error: 'Forbidden' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    await memoryHandler.saveConversation(env, message);
    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // GET /api/memory/preferences/:userId - Get user preferences
  const prefsMatch = path.match(/^\/api\/memory\/preferences\/([^/]+)$/);
  if (prefsMatch && request.method === 'GET') {
    const userId = prefsMatch[1];

    // SECURITY: Validate userId format
    const validation = validatePathParameter(userId, UserIdPathSchema, 'userId', '/api/memory/preferences/:userId');
    if (!validation.success) {
      return validation.response;
    }

    // SECURITY: Verify that the API key is authorized to access this userId
    if (!await authorizeUserAccess(request, userId, env)) {
      safeLog.warn('[Memory API] Unauthorized access attempt', {
        endpoint: '/preferences',
        requestedUserId: maskUserId(userId),
      });
      return new Response(JSON.stringify({ error: 'Forbidden' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const prefs = await memoryHandler.getUserPreferences(env, userId);
    return new Response(JSON.stringify({ preferences: prefs }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // POST /api/memory/preferences - Save user preferences
  if (path === '/api/memory/preferences' && request.method === 'POST') {
    const validation = await validateRequestBody(request, UserPreferencesSchema, '/api/memory/preferences');
    if (!validation.success) {
      return validation.response;
    }

    const prefs = validation.data as UserPreferences;

    // SECURITY: Verify that the API key is authorized to save preferences for this userId
    if (!await authorizeUserAccess(request, prefs.user_id, env)) {
      safeLog.warn('[Memory API] Unauthorized access attempt', {
        endpoint: '/preferences (POST)',
        requestedUserId: maskUserId(prefs.user_id),
      });
      return new Response(JSON.stringify({ error: 'Forbidden' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    await memoryHandler.saveUserPreferences(env, prefs);
    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // POST /api/memory/cleanup - Cleanup old conversations
  if (path === '/api/memory/cleanup' && request.method === 'POST') {
    const deleted = await memoryHandler.cleanupOldConversations(env);
    return new Response(JSON.stringify({ success: true, deleted }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ error: 'Not found' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json' },
  });
}
