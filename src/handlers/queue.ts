/**
 * Queue API for AI Assistant Daemon
 *
 * Provides endpoints for task queue management:
 * - Claim tasks with lease mechanism
 * - Release and renew leases
 * - Update task status
 * - Store and retrieve results
 */

import { Env } from '../types';
import { safeLog, maskUserId } from '../utils/log-sanitizer';
import { checkRateLimit, createRateLimitResponse } from '../utils/rate-limiter';
import { validateRequestBody, validatePathParameter } from '../schemas/validation-helper';
import {
  ClaimTaskSchema,
  ReleaseTaskSchema,
  RenewTaskSchema,
  UpdateStatusSchema,
  LeaseSchema,
  ResultSchema
} from '../schemas/queue';
import { TaskIdPathSchema } from '../schemas/path-params';

// Cache version for schema changes (update when KV schema changes)
const CACHE_VERSION = 'v1';

type APIScope = 'queue' | 'memory' | 'admin';

/**
 * Verify API Key with constant-time comparison
 */
export function verifyAPIKey(request: Request, env: Env, scope: APIScope = 'queue'): boolean {
  // Get scoped key or fall back to legacy ASSISTANT_API_KEY
  const scopedKeys: Record<APIScope, string | undefined> = {
    queue: env.QUEUE_API_KEY || env.ASSISTANT_API_KEY,
    memory: env.MEMORY_API_KEY || env.ASSISTANT_API_KEY,
    admin: env.ADMIN_API_KEY, // No fallback for admin - explicit key required
  };

  const expectedKey = scopedKeys[scope];

  // SECURITY: Fail-closed - API Key is mandatory
  if (!expectedKey) {
    safeLog.error(`[API] ${scope.toUpperCase()}_API_KEY not configured - access denied`);
    return false;
  }

  const apiKey = request.headers.get('X-API-Key');
  if (!apiKey) {
    safeLog.warn(`[API] Missing API key for scope: ${scope}`);
    return false;
  }

  // Constant-time comparison to prevent timing attacks
  // Always execute full comparison regardless of length to prevent timing leaks
  let result = apiKey.length === expectedKey.length ? 0 : 1;
  const maxLen = Math.max(apiKey.length, expectedKey.length);
  for (let i = 0; i < maxLen; i++) {
    const a = i < apiKey.length ? apiKey.charCodeAt(i) : 0;
    const b = i < expectedKey.length ? expectedKey.charCodeAt(i) : 0;
    result |= a ^ b;
  }

  if (result !== 0) {
    safeLog.warn(`[API] Invalid API key for scope: ${scope}`);
    return false;
  }

  return true;
}

/**
 * Hash API key using SHA-256 and return first 16 characters
 * Used for storing API key -> userId mappings without exposing full keys
 */
export async function hashAPIKey(apiKey: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(apiKey);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  return hashHex.substring(0, 16);
}

interface APIKeyMapping {
  userId: string;
  role?: 'service' | 'user';
}

/**
 * Extract userId and role from API key by looking up KV mapping
 * Returns null if mapping doesn't exist
 *
 * SECURITY: This prevents IDOR by deriving userId from cryptographic API key
 * instead of trusting URL parameters.
 * Service role keys (role: 'service') bypass per-user checks for system daemons.
 */
async function extractUserIdFromKey(apiKey: string, env: Env): Promise<APIKeyMapping | null> {
  if (!env.CACHE) {
    safeLog.error('[API] CACHE KV namespace not available');
    return null;
  }

  const keyHash = await hashAPIKey(apiKey);
  const mappingKey = `apikey:mapping:${keyHash}`;

  const mapping = await env.CACHE.get(mappingKey, 'json') as APIKeyMapping | null;

  if (!mapping || !mapping.userId) {
    safeLog.warn('[API] No userId mapping found for API key', { keyHash: keyHash.substring(0, 8) });
    return null;
  }

  return mapping;
}

/**
 * Verify that the requested userId matches the userId derived from API key
 * Returns true if authorized, false otherwise
 *
 * SECURITY: Prevents IDOR by ensuring users can only access their own data.
 * Service role keys (role: 'service') bypass per-user checks for system daemons
 * like assistant-daemon.js that process tasks for all users.
 */
export async function authorizeUserAccess(
  request: Request,
  requestedUserId: string,
  env: Env
): Promise<boolean> {
  const apiKey = request.headers.get('X-API-Key');
  if (!apiKey) {
    safeLog.warn('[API] Missing API key for authorization');
    return false;
  }

  const mapping = await extractUserIdFromKey(apiKey, env);
  if (!mapping) {
    safeLog.warn('[API] Failed to derive userId from API key');
    return false;
  }

  // Service role: bypass per-user check (for system daemons)
  if (mapping.role === 'service') {
    safeLog.log('[API:audit] Service role access', {
      targetUserId: maskUserId(requestedUserId),
      serviceId: maskUserId(mapping.userId),
      endpoint: new URL(request.url).pathname,
    });
    return true;
  }

  const derivedUserId = mapping.userId;

  // Constant-time comparison to prevent timing attacks
  // Always execute full comparison regardless of length to prevent timing leaks
  let result = derivedUserId.length === requestedUserId.length ? 0 : 1;
  const maxLen = Math.max(derivedUserId.length, requestedUserId.length);
  for (let i = 0; i < maxLen; i++) {
    const a = i < derivedUserId.length ? derivedUserId.charCodeAt(i) : 0;
    const b = i < requestedUserId.length ? requestedUserId.charCodeAt(i) : 0;
    result |= a ^ b;
  }

  const authorized = result === 0;

  if (!authorized) {
    safeLog.warn('[API] Authorization failed: userId mismatch', {
      requested: maskUserId(requestedUserId),
      derived: maskUserId(derivedUserId),
    });
  }

  return authorized;
}

export async function handleQueueAPI(request: Request, env: Env, path: string): Promise<Response> {
  // Verify API Key with 'queue' scope (fail-closed, generic error to prevent enumeration)
  if (!verifyAPIKey(request, env, 'queue')) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Rate limiting for Queue API (keyed on API key hash for client identification)
  const apiKey = request.headers.get('X-API-Key') || 'unknown';
  const clientId = `key:${apiKey.substring(0, 8)}`; // Use first 8 chars as identifier
  const rateLimitResult = await checkRateLimit(env, 'queue', clientId);
  if (!rateLimitResult.allowed) {
    safeLog.warn('[Queue API] Rate limit exceeded', { clientId: clientId.substring(0, 12) });
    return createRateLimitResponse(rateLimitResult);
  }

  if (!env.CACHE) {
    return new Response(JSON.stringify({ error: 'KV not configured' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const kv = env.CACHE;

  // GET /api/queue - List pending tasks
  if (path === '/api/queue' && request.method === 'GET') {
    const pending = await kv.get<string[]>(`${CACHE_VERSION}:orchestrator:pending`, 'json') || [];
    return new Response(JSON.stringify({ pending, count: pending.length }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // POST /api/queue/claim - Atomically claim next available task (lease mechanism)
  // SECURITY: Uses nonce-based verification to prevent race conditions
  if (path === '/api/queue/claim' && request.method === 'POST') {
    const validation = await validateRequestBody(request, ClaimTaskSchema, '/api/queue/claim');
    if (!validation.success) {
      return validation.response;
    }

    const body = validation.data;
    const workerId = body.workerId || `worker_${Date.now()}`;
    const leaseDuration = Math.min(body.leaseDurationSec || 300, 600); // Max 10 minutes

    const pending = await kv.get<string[]>(`${CACHE_VERSION}:orchestrator:pending`, 'json') || [];

    // OPTIMIZATION: Batch fetch all active leases instead of checking one by one
    // This reduces KV operations from N to 1 when there are many leased tasks
    const leasePrefix = 'orchestrator:lease:';
    const activeLeasesResult = await kv.list({ prefix: leasePrefix });
    const leasedTaskIds = new Set(
      activeLeasesResult.keys.map(key => key.name.substring(leasePrefix.length))
    );

    // Find first task that isn't already leased
    for (const taskId of pending) {
      const leaseKey = `orchestrator:lease:${taskId}`;

      // O(1) lookup against pre-fetched leased tasks
      if (leasedTaskIds.has(taskId)) {
        // Task already leased by another worker
        continue;
      }

      // RACE CONDITION FIX: Generate unique nonce for this claim attempt
      // The nonce ensures we can detect if another worker wrote between our check and write
      const claimNonce = `${workerId}:${Date.now()}:${Math.random().toString(36).substring(2, 10)}`;

      // Try to acquire lease
      const leaseData = {
        workerId,
        claimNonce, // Unique identifier for this specific claim attempt
        claimedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + leaseDuration * 1000).toISOString(),
      };

      await kv.put(leaseKey, JSON.stringify(leaseData), { expirationTtl: leaseDuration });

      // RACE CONDITION FIX: Verify nonce matches (not just workerId)
      // If another worker wrote after us, the nonce will be different
      const verifyLease = await kv.get<typeof leaseData>(leaseKey, 'json');
      if (verifyLease?.claimNonce !== claimNonce) {
        // Lost race - another worker's lease overwrote ours
        safeLog.log('[Queue API] Lost race for task', { taskId, workerId });
        continue;
      }

      // Successfully claimed - fetch task details
      const task = await kv.get(`${CACHE_VERSION}:orchestrator:queue:${taskId}`, 'json');
      if (!task) {
        // Task was deleted, release lease and try next
        await kv.delete(leaseKey);
        continue;
      }

      safeLog.log('[Queue API] Task claimed', { taskId, workerId, leaseDuration });

      return new Response(JSON.stringify({
        success: true,
        taskId,
        task,
        lease: leaseData,
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // No available tasks
    return new Response(JSON.stringify({
      success: false,
      message: 'No tasks available or all tasks are leased',
      pending: pending.length,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // POST /api/queue/:taskId/release - Release a lease (on failure or cancellation)
  const releaseMatch = path.match(/^\/api\/queue\/([^/]+)\/release$/);
  if (releaseMatch && request.method === 'POST') {
    const taskId = releaseMatch[1];

    // SECURITY: Validate taskId format
    const taskIdValidation = validatePathParameter(taskId, TaskIdPathSchema, 'taskId', '/api/queue/:taskId/release');
    if (!taskIdValidation.success) {
      return taskIdValidation.response;
    }

    const validation = await validateRequestBody(request, ReleaseTaskSchema, '/api/queue/:taskId/release');
    if (!validation.success) {
      return validation.response;
    }

    const body = validation.data;
    const leaseKey = `orchestrator:lease:${taskId}`;

    const leaseData = await kv.get(leaseKey, 'json');
    if (!leaseData) {
      return new Response(JSON.stringify({ success: true, message: 'No active lease' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Validate lease data structure
    const leaseValidation = LeaseSchema.safeParse(leaseData);
    if (!leaseValidation.success) {
      safeLog.error('[Queue API] Invalid lease data structure', {
        taskId,
        errors: leaseValidation.error.errors
      });
      return new Response(JSON.stringify({
        error: 'Invalid lease data',
        details: leaseValidation.error.errors
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const lease = leaseValidation.data;

    // Only the lease holder can release (or if workerId not provided, anyone can release)
    if (body.workerId && lease.workerId !== body.workerId) {
      return new Response(JSON.stringify({ error: 'Not lease holder' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    await kv.delete(leaseKey);
    safeLog.log('[Queue API] Lease released', { taskId, reason: body.reason || 'manual' });

    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // POST /api/queue/:taskId/renew - Renew a lease (extend TTL)
  const renewMatch = path.match(/^\/api\/queue\/([^/]+)\/renew$/);
  if (renewMatch && request.method === 'POST') {
    const taskId = renewMatch[1];

    // SECURITY: Validate taskId format
    const taskIdValidation = validatePathParameter(taskId, TaskIdPathSchema, 'taskId', '/api/queue/:taskId/renew');
    if (!taskIdValidation.success) {
      return taskIdValidation.response;
    }

    const validation = await validateRequestBody(request, RenewTaskSchema, '/api/queue/:taskId/renew');
    if (!validation.success) {
      return validation.response;
    }

    const body = validation.data;
    const leaseKey = `orchestrator:lease:${taskId}`;
    const extendDuration = Math.min(body.extendSec || 300, 600);

    const lease = await kv.get<{ workerId: string; claimedAt: string }>(leaseKey, 'json');
    if (!lease || lease.workerId !== body.workerId) {
      return new Response(JSON.stringify({ error: 'Invalid lease or not holder' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const renewedLease = {
      ...lease,
      expiresAt: new Date(Date.now() + extendDuration * 1000).toISOString(),
      renewedAt: new Date().toISOString(),
    };

    await kv.put(leaseKey, JSON.stringify(renewedLease), { expirationTtl: extendDuration });

    return new Response(JSON.stringify({ success: true, lease: renewedLease }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // GET /api/queue/:taskId - Get specific task
  const taskMatch = path.match(/^\/api\/queue\/([^/]+)$/);
  if (taskMatch && request.method === 'GET') {
    const taskId = taskMatch[1];

    // SECURITY: Validate taskId format
    const taskIdValidation = validatePathParameter(taskId, TaskIdPathSchema, 'taskId', '/api/queue/:taskId');
    if (!taskIdValidation.success) {
      return taskIdValidation.response;
    }

    const task = await kv.get(`${CACHE_VERSION}:orchestrator:queue:${taskId}`, 'json');
    if (!task) {
      return new Response(JSON.stringify({ error: 'Task not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify(task), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // POST /api/queue/:taskId/status - Update task status
  const statusMatch = path.match(/^\/api\/queue\/([^/]+)\/status$/);
  if (statusMatch && request.method === 'POST') {
    const taskId = statusMatch[1];

    // SECURITY: Validate taskId format
    const taskIdValidation = validatePathParameter(taskId, TaskIdPathSchema, 'taskId', '/api/queue/:taskId/status');
    if (!taskIdValidation.success) {
      return taskIdValidation.response;
    }

    const validation = await validateRequestBody(request, UpdateStatusSchema, '/api/queue/:taskId/status');
    if (!validation.success) {
      return validation.response;
    }

    const body = validation.data;

    const task = await kv.get(`${CACHE_VERSION}:orchestrator:queue:${taskId}`, 'json') as Record<string, unknown> | null;
    if (!task) {
      return new Response(JSON.stringify({ error: 'Task not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Update task status
    task.status = body.status;
    task.updatedAt = new Date().toISOString();
    await kv.put(`${CACHE_VERSION}:orchestrator:queue:${taskId}`, JSON.stringify(task), { expirationTtl: 3600 });

    return new Response(JSON.stringify({ success: true, status: body.status }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // POST /api/result/:taskId - Store result and remove from queue
  const resultMatch = path.match(/^\/api\/result\/([^/]+)$/);
  if (resultMatch && request.method === 'POST') {
    const taskId = resultMatch[1];

    // SECURITY: Validate taskId format
    const taskIdValidation = validatePathParameter(taskId, TaskIdPathSchema, 'taskId', '/api/result/:taskId');
    if (!taskIdValidation.success) {
      return taskIdValidation.response;
    }

    const validation = await validateRequestBody(request, ResultSchema, '/api/result/:taskId');
    if (!validation.success) {
      return validation.response;
    }

    const result = validation.data;

    // Store result
    await kv.put(`${CACHE_VERSION}:orchestrator:result:${taskId}`, JSON.stringify(result), {
      expirationTtl: 3600,
    });

    // Remove from pending list
    const pendingList = await kv.get<string[]>(`${CACHE_VERSION}:orchestrator:pending`, 'json') || [];
    const updatedList = pendingList.filter(id => id !== taskId);
    await kv.put(`${CACHE_VERSION}:orchestrator:pending`, JSON.stringify(updatedList), { expirationTtl: 3600 });

    // Delete queue entry
    await kv.delete(`${CACHE_VERSION}:orchestrator:queue:${taskId}`);

    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // GET /api/result/:taskId - Get result
  if (resultMatch && request.method === 'GET') {
    const taskId = resultMatch[1];

    // SECURITY: Validate taskId format
    const taskIdValidation = validatePathParameter(taskId, TaskIdPathSchema, 'taskId', '/api/result/:taskId');
    if (!taskIdValidation.success) {
      return taskIdValidation.response;
    }

    const result = await kv.get(`${CACHE_VERSION}:orchestrator:result:${taskId}`, 'json');
    if (!result) {
      return new Response(JSON.stringify({ error: 'Result not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify(result), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ error: 'Not found' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json' },
  });
}
