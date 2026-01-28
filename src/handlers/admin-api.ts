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
import { validateRequestBody } from '../schemas/validation-helper';
import { CreateAPIKeyMappingSchema, DeleteAPIKeyMappingSchema, CreateAPIKeyMappingInput, DeleteAPIKeyMappingInput } from '../schemas/admin';

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
      const validation = await validateRequestBody(request, CreateAPIKeyMappingSchema, '/api/admin/apikey/mapping');
      if (!validation.success) {
        return validation.response;
      }

      const body = validation.data as CreateAPIKeyMappingInput;

      if (!env.CACHE) {
        return new Response(JSON.stringify({ error: 'CACHE KV namespace not available' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const keyHash = await hashAPIKey(body.apiKey);
      const mappingKey = `apikey:mapping:${keyHash}`;

      const mappingValue = { userId: body.userId, role: body.role };
      await env.CACHE.put(mappingKey, JSON.stringify(mappingValue));

      safeLog.log('[Admin API] Created API key mapping', {
        keyHash: keyHash.substring(0, 8),
        userId: maskUserId(body.userId),
        role: body.role,
      });

      return new Response(JSON.stringify({
        success: true,
        keyHash: keyHash.substring(0, 8),
        userId: body.userId,
        role: body.role,
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
      const validation = await validateRequestBody(request, DeleteAPIKeyMappingSchema, '/api/admin/apikey/mapping');
      if (!validation.success) {
        return validation.response;
      }

      const body = validation.data as DeleteAPIKeyMappingInput;

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
