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
import {
  CreateAPIKeyMappingSchema,
  DeleteAPIKeyMappingSchema,
  CreateAPIKeyMappingInput,
  DeleteAPIKeyMappingInput,
  MigrateQueueKVToD1Schema,
  MigrateQueueKVToD1Input,
  MigrateResultsKVToD1Schema,
  MigrateResultsKVToD1Input,
} from '../schemas/admin';
import { migrateQueueTasksKVToD1, migrateResultsKVToD1 } from '../utils/queue-kv-to-d1';

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
  // Use legacy channel-based limiter for admin endpoints (stable policy + matches tests).
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

      if (!env.DB) {
        return new Response(JSON.stringify({ error: 'DB not available' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const keyHash = await hashAPIKey(body.apiKey);

      const mappingValue = { userId: body.userId, role: body.role };
      await env.DB.prepare(
        `INSERT INTO api_key_mappings (key_hash, user_id, role, updated_at)
         VALUES (?, ?, ?, strftime('%s','now'))
         ON CONFLICT(key_hash) DO UPDATE SET
           user_id=excluded.user_id,
           role=excluded.role,
           updated_at=strftime('%s','now')`
      ).bind(keyHash, body.userId, body.role).run();

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

  // POST /api/admin/queue/migrate-tasks-kv-to-d1 - One-time migration helper
  if (path === '/api/admin/queue/migrate-tasks-kv-to-d1' && request.method === 'POST') {
    try {
      const validation = await validateRequestBody(request, MigrateQueueKVToD1Schema, '/api/admin/queue/migrate-tasks-kv-to-d1');
      if (!validation.success) return validation.response;

      const body = validation.data as MigrateQueueKVToD1Input;
      if (!env.DB || !env.CACHE) {
        return new Response(JSON.stringify({ error: 'DB and CACHE are required' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const res = await migrateQueueTasksKVToD1(env, {
        cursor: body.cursor,
        limit: body.limit,
        cleanup: body.cleanup,
      });

      return new Response(JSON.stringify({ success: true, ...res }), {
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      safeLog.error('[Admin API] Error migrating queue tasks KV->D1', { error: String(error) });
      return new Response(JSON.stringify({ error: 'Migration failed' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  // POST /api/admin/queue/migrate-results-kv-to-d1 - One-time migration helper
  if (path === '/api/admin/queue/migrate-results-kv-to-d1' && request.method === 'POST') {
    try {
      const validation = await validateRequestBody(request, MigrateResultsKVToD1Schema, '/api/admin/queue/migrate-results-kv-to-d1');
      if (!validation.success) return validation.response;

      const body = validation.data as MigrateResultsKVToD1Input;
      if (!env.DB || !env.CACHE) {
        return new Response(JSON.stringify({ error: 'DB and CACHE are required' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const res = await migrateResultsKVToD1(env, {
        cursor: body.cursor,
        limit: body.limit,
        cleanup: body.cleanup,
      });

      return new Response(JSON.stringify({ success: true, ...res }), {
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      safeLog.error('[Admin API] Error migrating results KV->D1', { error: String(error) });
      return new Response(JSON.stringify({ error: 'Migration failed' }), {
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

      if (!env.DB) {
        return new Response(JSON.stringify({ error: 'DB not available' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const keyHash = await hashAPIKey(body.apiKey);
      await env.DB.prepare(
        `DELETE FROM api_key_mappings WHERE key_hash = ?`
      ).bind(keyHash).run();

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
