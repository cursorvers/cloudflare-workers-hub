/**
 * Admin API for API Key Management
 *
 * Provides endpoints for managing API key -> userId mappings:
 * - Create API key mapping
 * - Delete API key mapping
 */

import { Env } from '../types';
import { safeLog, maskUserId } from '../utils/log-sanitizer';
import { checkRateLimit, createRateLimitResponse } from '../utils/rate-limiter';
import { verifyAPIKey, hashAPIKey } from '../utils/api-auth';

export async function handleAdminAPI(request: Request, env: Env, path: string): Promise<Response> {
  // Verify API key with admin scope
  if (!verifyAPIKey(request, env, 'admin')) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Rate limit check
  const apiKey = request.headers.get('X-API-Key') || '';
  const rateLimitResult = await checkRateLimit(env, 'admin', apiKey.substring(0, 8));
  if (!rateLimitResult.allowed) {
    return createRateLimitResponse(rateLimitResult);
  }

  // POST /api/admin/apikey/mapping - Create API key -> userId mapping
  if (path === '/api/admin/apikey/mapping' && request.method === 'POST') {
    try {
      const body = await request.json() as { apiKey: string; userId: string; role?: string };

      if (!body.apiKey || !body.userId) {
        return new Response(JSON.stringify({ error: 'Missing required fields: apiKey, userId' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Validate role if provided
      const validRoles = ['service', 'user'] as const;
      const role = body.role || 'user';
      if (!validRoles.includes(role as typeof validRoles[number])) {
        return new Response(JSON.stringify({ error: 'Invalid role. Must be "service" or "user"' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (!env.CACHE) {
        return new Response(JSON.stringify({ error: 'CACHE KV namespace not available' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const keyHash = await hashAPIKey(body.apiKey);
      const mappingKey = `apikey:mapping:${keyHash}`;

      const mappingValue = { userId: body.userId, role };
      await env.CACHE.put(mappingKey, JSON.stringify(mappingValue));

      safeLog.log('[Admin API] Created API key mapping', {
        keyHash: keyHash.substring(0, 8),
        userId: maskUserId(body.userId),
        role,
      });

      return new Response(JSON.stringify({
        success: true,
        keyHash: keyHash.substring(0, 8),
        userId: body.userId,
        role,
      }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      safeLog.error('[Admin API] Error creating mapping', { error: String(error) });
      return new Response(JSON.stringify({
        error: 'Failed to create API key mapping',
        type: 'internal_error',
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  // DELETE /api/admin/apikey/mapping - Delete API key mapping
  if (path === '/api/admin/apikey/mapping' && request.method === 'DELETE') {
    try {
      const body = await request.json() as { apiKey: string };

      if (!body.apiKey) {
        return new Response(JSON.stringify({ error: 'Missing required field: apiKey' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (!env.CACHE) {
        return new Response(JSON.stringify({ error: 'CACHE KV namespace not available' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const keyHash = await hashAPIKey(body.apiKey);
      const mappingKey = `apikey:mapping:${keyHash}`;

      await env.CACHE.delete(mappingKey);

      safeLog.log('[Admin API] Deleted API key mapping', {
        keyHash: keyHash.substring(0, 8),
      });

      return new Response(JSON.stringify({
        success: true,
        keyHash: keyHash.substring(0, 8),
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      safeLog.error('[Admin API] Error deleting mapping', { error: String(error) });
      return new Response(JSON.stringify({
        error: 'Failed to delete API key mapping',
        type: 'internal_error',
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  return new Response(JSON.stringify({ error: 'Not found' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json' },
  });
}
