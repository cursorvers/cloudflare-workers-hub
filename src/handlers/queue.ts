/**
 * Queue API for AI Assistant Daemon
 *
 * Provides endpoints for task queue management:
 * - Claim tasks with lease mechanism (via Durable Object for atomicity)
 * - Release and renew leases
 * - Update task status
 * - Store and retrieve results
 *
 * Architecture: Task data in KV, lease coordination in Durable Object.
 * Falls back to KV-only mode when DO is unavailable (dev/test).
 */

import { Env } from '../types';
import { safeLog } from '../utils/log-sanitizer';
import { checkRateLimit, createRateLimitResponse } from '../utils/rate-limiter';
import { validateRequestBody, validatePathParameter } from '../schemas/validation-helper';
import {
  ClaimTaskSchema,
  ReleaseTaskSchema,
  RenewTaskSchema,
  UpdateStatusSchema,
  ResultSchema
} from '../schemas/queue';
import { TaskIdPathSchema } from '../schemas/path-params';
import { verifyAPIKey } from '../utils/api-auth';
import { getTaskIds, removeFromTaskIndex } from '../utils/task-index';

/** Get the TaskCoordinator DO singleton stub */
function getCoordinatorStub(env: Env): DurableObjectStub | null {
  if (!env.TASK_COORDINATOR) return null;
  const id = env.TASK_COORDINATOR.idFromName('default-queue');
  return env.TASK_COORDINATOR.get(id);
}

/** Send a request to the DO and parse JSON response */
async function coordinatorFetch(
  stub: DurableObjectStub,
  path: string,
  method: string,
  body?: unknown,
  env?: Env,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  // Add internal bearer token for DO authentication
  if (env?.QUEUE_API_KEY) {
    headers['Authorization'] = `Bearer ${env.QUEUE_API_KEY}`;
  }
  const init: RequestInit = { method, headers };
  if (body) init.body = JSON.stringify(body);

  const res = await stub.fetch(new Request(`http://do${path}`, init));
  const data = await res.json() as Record<string, unknown>;
  return { status: res.status, data };
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

export async function handleQueueAPI(request: Request, env: Env, path: string): Promise<Response> {
  // Verify API Key with 'queue' scope (fail-closed, generic error to prevent enumeration)
  if (!verifyAPIKey(request, env, 'queue')) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: JSON_HEADERS,
    });
  }

  // Rate limiting for Queue API (keyed on API key hash for client identification)
  const apiKey = request.headers.get('X-API-Key') || 'unknown';
  const clientId = `key:${apiKey.substring(0, 8)}`;
  const rateLimitResult = await checkRateLimit(env, 'queue', clientId);
  if (!rateLimitResult.allowed) {
    safeLog.warn('[Queue API] Rate limit exceeded', { clientId: clientId.substring(0, 12) });
    return createRateLimitResponse(rateLimitResult);
  }

  if (!env.CACHE) {
    return new Response(JSON.stringify({ error: 'KV not configured' }), {
      status: 503, headers: JSON_HEADERS,
    });
  }

  const kv = env.CACHE;
  const coordinator = getCoordinatorStub(env);

  // GET /api/queue - List pending tasks (cached to reduce KV list ops)
  if (path === '/api/queue' && request.method === 'GET') {
    const pending = await getTaskIds(kv);

    safeLog.log('[Queue API] Listed tasks', { count: pending.length });

    return new Response(JSON.stringify({ pending, count: pending.length }), {
      headers: JSON_HEADERS,
    });
  }

  // POST /api/queue/claim - Atomically claim next available task
  if (path === '/api/queue/claim' && request.method === 'POST') {
    const validation = await validateRequestBody(request, ClaimTaskSchema, '/api/queue/claim');
    if (!validation.success) return validation.response;

    const body = validation.data;
    const workerId = body.workerId || `worker_${Date.now()}`;
    const leaseDuration = Math.min(body.leaseDurationSec || 300, 600);

    // Get task IDs (cached to reduce KV list ops)
    const candidates = await getTaskIds(kv);

    if (candidates.length === 0) {
      return new Response(JSON.stringify({
        success: false, message: 'No tasks available', pending: 0,
      }), { headers: JSON_HEADERS });
    }

    // Route through DO for atomic claim (or fall back to KV)
    if (coordinator) {
      return claimViaDO(coordinator, kv, candidates, workerId, leaseDuration, env);
    }
    return claimViaKV(kv, candidates, workerId, leaseDuration);
  }

  // POST /api/queue/:taskId/release - Release a lease
  const releaseMatch = path.match(/^\/api\/queue\/([^/]+)\/release$/);
  if (releaseMatch && request.method === 'POST') {
    const taskId = releaseMatch[1];
    const taskIdValidation = validatePathParameter(taskId, TaskIdPathSchema, 'taskId', '/api/queue/:taskId/release');
    if (!taskIdValidation.success) return taskIdValidation.response;

    const validation = await validateRequestBody(request, ReleaseTaskSchema, '/api/queue/:taskId/release');
    if (!validation.success) return validation.response;

    const body = validation.data;

    if (coordinator) {
      const { status, data } = await coordinatorFetch(coordinator, '/release', 'POST', {
        taskId, workerId: body.workerId,
      }, env);
      safeLog.log('[Queue API] Lease released via DO', { taskId, reason: body.reason || 'manual' });
      return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
    }

    // KV fallback
    return releaseViaKV(kv, taskId, body);
  }

  // POST /api/queue/:taskId/renew - Renew a lease
  const renewMatch = path.match(/^\/api\/queue\/([^/]+)\/renew$/);
  if (renewMatch && request.method === 'POST') {
    const taskId = renewMatch[1];
    const taskIdValidation = validatePathParameter(taskId, TaskIdPathSchema, 'taskId', '/api/queue/:taskId/renew');
    if (!taskIdValidation.success) return taskIdValidation.response;

    const validation = await validateRequestBody(request, RenewTaskSchema, '/api/queue/:taskId/renew');
    if (!validation.success) return validation.response;

    const body = validation.data;
    const extendDuration = Math.min(body.extendSec || 300, 600);

    if (coordinator) {
      const { status, data } = await coordinatorFetch(coordinator, '/renew', 'POST', {
        taskId, workerId: body.workerId, extendSec: extendDuration,
      }, env);
      return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
    }

    // KV fallback
    return renewViaKV(kv, taskId, body.workerId, extendDuration);
  }

  // GET /api/queue/:taskId - Get specific task (KV only)
  const taskMatch = path.match(/^\/api\/queue\/([^/]+)$/);
  if (taskMatch && request.method === 'GET') {
    const taskId = taskMatch[1];
    const taskIdValidation = validatePathParameter(taskId, TaskIdPathSchema, 'taskId', '/api/queue/:taskId');
    if (!taskIdValidation.success) return taskIdValidation.response;

    const task = await kv.get(`queue:task:${taskId}`, 'json');
    if (!task) {
      return new Response(JSON.stringify({ error: 'Task not found' }), {
        status: 404, headers: JSON_HEADERS,
      });
    }
    return new Response(JSON.stringify(task), { headers: JSON_HEADERS });
  }

  // POST /api/queue/:taskId/status - Update task status (KV only)
  const statusMatch = path.match(/^\/api\/queue\/([^/]+)\/status$/);
  if (statusMatch && request.method === 'POST') {
    const taskId = statusMatch[1];
    const taskIdValidation = validatePathParameter(taskId, TaskIdPathSchema, 'taskId', '/api/queue/:taskId/status');
    if (!taskIdValidation.success) return taskIdValidation.response;

    const validation = await validateRequestBody(request, UpdateStatusSchema, '/api/queue/:taskId/status');
    if (!validation.success) return validation.response;

    const body = validation.data;
    const task = await kv.get(`queue:task:${taskId}`, 'json') as Record<string, unknown> | null;
    if (!task) {
      return new Response(JSON.stringify({ error: 'Task not found' }), {
        status: 404, headers: JSON_HEADERS,
      });
    }

    const updatedTask = { ...task, status: body.status, updatedAt: new Date().toISOString() };
    await kv.put(`queue:task:${taskId}`, JSON.stringify(updatedTask), { expirationTtl: 3600 });

    return new Response(JSON.stringify({ success: true, status: body.status }), {
      headers: JSON_HEADERS,
    });
  }

  // POST /api/result/:taskId - Store result and remove from queue
  const resultMatch = path.match(/^\/api\/result\/([^/]+)$/);
  if (resultMatch && request.method === 'POST') {
    const taskId = resultMatch[1];
    const taskIdValidation = validatePathParameter(taskId, TaskIdPathSchema, 'taskId', '/api/result/:taskId');
    if (!taskIdValidation.success) return taskIdValidation.response;

    const validation = await validateRequestBody(request, ResultSchema, '/api/result/:taskId');
    if (!validation.success) return validation.response;

    // Store result (backwards compatible key)
    await kv.put(`orchestrator:result:${taskId}`, JSON.stringify(validation.data), {
      expirationTtl: 3600,
    });

    // Delete task from KV and update cached index
    await kv.delete(`queue:task:${taskId}`);
    await removeFromTaskIndex(kv, taskId);

    // Delete lease from DO (or KV fallback)
    if (coordinator) {
      await coordinatorFetch(coordinator, `/task/${taskId}`, 'DELETE', undefined, env);
    } else {
      await kv.delete(`queue:lease:${taskId}`);
    }

    safeLog.log('[Queue API] Task completed and removed', { taskId });
    return new Response(JSON.stringify({ success: true }), { headers: JSON_HEADERS });
  }

  // GET /api/result/:taskId - Get result (KV only)
  if (resultMatch && request.method === 'GET') {
    const taskId = resultMatch[1];
    const taskIdValidation = validatePathParameter(taskId, TaskIdPathSchema, 'taskId', '/api/result/:taskId');
    if (!taskIdValidation.success) return taskIdValidation.response;

    const result = await kv.get(`orchestrator:result:${taskId}`, 'json');
    if (!result) {
      return new Response(JSON.stringify({ error: 'Result not found' }), {
        status: 404, headers: JSON_HEADERS,
      });
    }
    return new Response(JSON.stringify(result), { headers: JSON_HEADERS });
  }

  return new Response(JSON.stringify({ error: 'Not found' }), {
    status: 404, headers: JSON_HEADERS,
  });
}

// ─── DO-based claim (atomic, no race condition) ─────────────────────

async function claimViaDO(
  coordinator: DurableObjectStub,
  kv: KVNamespace,
  candidates: string[],
  workerId: string,
  leaseDuration: number,
  env: Env,
): Promise<Response> {
  const { data } = await coordinatorFetch(coordinator, '/claim-next', 'POST', {
    candidates, workerId, leaseDurationSec: leaseDuration,
  }, env);

  if (!data.claimed) {
    return new Response(JSON.stringify({
      success: false, message: 'No tasks available or all tasks are leased', pending: candidates.length,
    }), { headers: JSON_HEADERS });
  }

  const taskId = data.taskId as string;
  const task = await kv.get(`queue:task:${taskId}`, 'json');
  if (!task) {
    // Task was deleted between scan and claim; release DO lease and retry once
    await coordinatorFetch(coordinator, `/task/${taskId}`, 'DELETE', undefined, env);
    safeLog.warn('[Queue API] Task disappeared after DO claim', { taskId });
    return new Response(JSON.stringify({
      success: false, message: 'Task no longer available', pending: candidates.length,
    }), { headers: JSON_HEADERS });
  }

  safeLog.log('[Queue API] Task claimed via DO', { taskId, workerId, leaseDuration });

  return new Response(JSON.stringify({
    success: true, taskId, task, lease: data.lease,
  }), { headers: JSON_HEADERS });
}

// ─── KV fallback (nonce-based, for dev/test) ────────────────────────

async function claimViaKV(
  kv: KVNamespace,
  candidates: string[],
  workerId: string,
  leaseDuration: number,
): Promise<Response> {
  // Pre-fetch active leases
  const activeLeasesResult = await kv.list({ prefix: 'queue:lease:' });
  const leasedTaskIds = new Set(
    activeLeasesResult.keys.map(key => key.name.replace('queue:lease:', ''))
  );

  for (const taskId of candidates) {
    if (leasedTaskIds.has(taskId)) continue;

    const claimNonce = `${workerId}:${Date.now()}:${Math.random().toString(36).substring(2, 10)}`;
    const leaseData = {
      workerId,
      claimNonce,
      claimedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + leaseDuration * 1000).toISOString(),
    };

    await kv.put(`queue:lease:${taskId}`, JSON.stringify(leaseData), { expirationTtl: leaseDuration });

    const verifyLease = await kv.get<typeof leaseData>(`queue:lease:${taskId}`, 'json');
    if (verifyLease?.claimNonce !== claimNonce) {
      safeLog.log('[Queue API] Lost race for task (KV fallback)', { taskId, workerId });
      continue;
    }

    const task = await kv.get(`queue:task:${taskId}`, 'json');
    if (!task) {
      await kv.delete(`queue:lease:${taskId}`);
      continue;
    }

    safeLog.log('[Queue API] Task claimed via KV fallback', { taskId, workerId, leaseDuration });

    return new Response(JSON.stringify({
      success: true, taskId, task, lease: leaseData,
    }), { headers: JSON_HEADERS });
  }

  return new Response(JSON.stringify({
    success: false, message: 'No tasks available or all tasks are leased', pending: candidates.length,
  }), { headers: JSON_HEADERS });
}

async function releaseViaKV(
  kv: KVNamespace,
  taskId: string,
  body: { workerId?: string; reason?: string },
): Promise<Response> {
  const leaseData = await kv.get(`queue:lease:${taskId}`, 'json') as { workerId: string } | null;
  if (!leaseData) {
    return new Response(JSON.stringify({ success: true, message: 'No active lease' }), {
      headers: JSON_HEADERS,
    });
  }

  if (body.workerId && leaseData.workerId !== body.workerId) {
    return new Response(JSON.stringify({ error: 'Not lease holder' }), {
      status: 403, headers: JSON_HEADERS,
    });
  }

  await kv.delete(`queue:lease:${taskId}`);
  safeLog.log('[Queue API] Lease released via KV fallback', { taskId, reason: body.reason || 'manual' });

  return new Response(JSON.stringify({ success: true }), { headers: JSON_HEADERS });
}

async function renewViaKV(
  kv: KVNamespace,
  taskId: string,
  workerId: string,
  extendDuration: number,
): Promise<Response> {
  const lease = await kv.get<{ workerId: string; claimedAt: string }>(`queue:lease:${taskId}`, 'json');
  if (!lease || lease.workerId !== workerId) {
    return new Response(JSON.stringify({ error: 'Invalid lease or not holder' }), {
      status: 403, headers: JSON_HEADERS,
    });
  }

  const renewedLease = {
    ...lease,
    expiresAt: new Date(Date.now() + extendDuration * 1000).toISOString(),
    renewedAt: new Date().toISOString(),
  };

  await kv.put(`queue:lease:${taskId}`, JSON.stringify(renewedLease), { expirationTtl: extendDuration });

  return new Response(JSON.stringify({ success: true, lease: renewedLease }), {
    headers: JSON_HEADERS,
  });
}
