/**
 * Cron API for Scheduled Task Management
 *
 * Provides endpoints for managing scheduled tasks:
 * - Get user's scheduled tasks
 * - Create scheduled task
 * - Get/Update/Delete specific task
 * - Toggle task enabled status
 * - Get due tasks (for daemon polling)
 * - Mark task as executed
 */

import { Env } from '../types';
import cronHandler, { CreateTaskInput, UpdateTaskInput } from './cron';
import { safeLog, maskUserId } from '../utils/log-sanitizer';
import { checkRateLimit, createRateLimitResponse } from '../utils/rate-limiter';
import { verifyAPIKey, authorizeUserAccess } from '../utils/api-auth';
import { validateRequestBody, validatePathParameter } from '../schemas/validation-helper';
import { CreateTaskSchema, UpdateTaskSchema } from '../schemas/cron';
import { UserIdPathSchema, TaskIdPathSchema } from '../schemas/path-params';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

// ─── Shared helpers ──────────────────────────────────────────────────

/** Validate taskId, fetch the task, and verify ownership. Returns the task or an error Response. */
async function fetchAndAuthorizeTask(
  request: Request,
  env: Env,
  taskId: string,
  endpoint: string,
): Promise<{ task: Awaited<ReturnType<typeof cronHandler.getTaskById>> } | { response: Response }> {
  const validation = validatePathParameter(taskId, TaskIdPathSchema, 'taskId', endpoint);
  if (!validation.success) {
    return { response: validation.response };
  }

  const task = await cronHandler.getTaskById(env, taskId);
  if (!task) {
    return { response: new Response(JSON.stringify({ error: 'Task not found' }), { status: 404, headers: JSON_HEADERS }) };
  }

  if (!await authorizeUserAccess(request, task.user_id, env)) {
    safeLog.warn('[Cron API] Unauthorized access attempt', {
      endpoint,
      taskId,
      taskUserId: maskUserId(task.user_id),
    });
    return { response: new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: JSON_HEADERS }) };
  }

  return { task };
}

/** Validate userId path param and verify authorization. Returns userId or an error Response. */
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
    safeLog.warn('[Cron API] Unauthorized access attempt', {
      endpoint,
      requestedUserId: maskUserId(userId),
    });
    return { response: new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: JSON_HEADERS }) };
  }

  return { userId };
}

// ─── Route handlers ──────────────────────────────────────────────────

async function handleGetUserTasks(request: Request, env: Env, rawUserId: string): Promise<Response> {
  const auth = await authorizeUserId(request, env, rawUserId, '/api/cron/tasks/:userId');
  if ('response' in auth) return auth.response;

  const tasks = await cronHandler.getScheduledTasks(env, auth.userId);
  return new Response(JSON.stringify({ tasks }), { headers: JSON_HEADERS });
}

async function handleCreateTask(request: Request, env: Env): Promise<Response> {
  const validation = await validateRequestBody(request, CreateTaskSchema, '/api/cron/tasks');
  if (!validation.success) return validation.response;

  const input = validation.data as CreateTaskInput;

  if (!await authorizeUserAccess(request, input.user_id, env)) {
    safeLog.warn('[Cron API] Unauthorized access attempt', {
      endpoint: '/tasks (POST)',
      requestedUserId: maskUserId(input.user_id),
    });
    return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: JSON_HEADERS });
  }

  try {
    const task = await cronHandler.createScheduledTask(env, input);
    return new Response(JSON.stringify({ success: true, task }), { status: 201, headers: JSON_HEADERS });
  } catch (error) {
    safeLog.error('[Cron API] Task creation failed', { endpoint: '/tasks (POST)', error: String(error) });
    return new Response(JSON.stringify({ error: 'Failed to create scheduled task', type: 'validation_error' }), {
      status: 400, headers: JSON_HEADERS,
    });
  }
}

async function handleGetTask(request: Request, env: Env, taskId: string): Promise<Response> {
  const result = await fetchAndAuthorizeTask(request, env, taskId, '/api/cron/task/:id');
  if ('response' in result) return result.response;

  return new Response(JSON.stringify({ task: result.task }), { headers: JSON_HEADERS });
}

async function handleUpdateTask(request: Request, env: Env, taskId: string): Promise<Response> {
  const result = await fetchAndAuthorizeTask(request, env, taskId, '/api/cron/task/:id');
  if ('response' in result) return result.response;

  const validation = await validateRequestBody(request, UpdateTaskSchema, '/api/cron/task/:id');
  if (!validation.success) return validation.response;

  const updates = validation.data as UpdateTaskInput;
  const task = await cronHandler.updateScheduledTask(env, taskId, updates);
  return new Response(JSON.stringify({ success: true, task }), { headers: JSON_HEADERS });
}

async function handleDeleteTask(request: Request, env: Env, taskId: string): Promise<Response> {
  const result = await fetchAndAuthorizeTask(request, env, taskId, '/api/cron/task/:id');
  if ('response' in result) return result.response;

  const deleted = await cronHandler.deleteScheduledTask(env, taskId);
  return new Response(JSON.stringify({ success: deleted }), { headers: JSON_HEADERS });
}

async function handleToggleTask(request: Request, env: Env, taskId: string): Promise<Response> {
  const result = await fetchAndAuthorizeTask(request, env, taskId, '/api/cron/task/:id/toggle');
  if ('response' in result) return result.response;

  const task = await cronHandler.toggleTaskEnabled(env, taskId);
  return new Response(JSON.stringify({ success: true, task }), { headers: JSON_HEADERS });
}

async function handleMarkExecuted(request: Request, env: Env, taskId: string): Promise<Response> {
  const result = await fetchAndAuthorizeTask(request, env, taskId, '/api/cron/task/:id/executed');
  if ('response' in result) return result.response;

  const task = await cronHandler.markTaskExecuted(env, taskId);
  return new Response(JSON.stringify({ success: true, task }), { headers: JSON_HEADERS });
}

// ─── Main router ─────────────────────────────────────────────────────

export async function handleCronAPI(request: Request, env: Env, path: string): Promise<Response> {
  if (!verifyAPIKey(request, env, 'admin')) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: JSON_HEADERS });
  }

  const apiKey = request.headers.get('Authorization')?.replace('Bearer ', '') || request.headers.get('X-API-Key') || '';
  const rateLimitResult = await checkRateLimit(env, 'admin', apiKey.substring(0, 8));
  if (!rateLimitResult.allowed) {
    return createRateLimitResponse(rateLimitResult);
  }

  // GET /api/cron/tasks/:userId
  const userTasksMatch = path.match(/^\/api\/cron\/tasks\/([^/]+)$/);
  if (userTasksMatch && request.method === 'GET') {
    return handleGetUserTasks(request, env, userTasksMatch[1]);
  }

  // POST /api/cron/tasks
  if (path === '/api/cron/tasks' && request.method === 'POST') {
    return handleCreateTask(request, env);
  }

  // GET/PUT/DELETE /api/cron/task/:id
  const taskMatch = path.match(/^\/api\/cron\/task\/([^/]+)$/);
  if (taskMatch) {
    const taskId = taskMatch[1];
    if (request.method === 'GET') return handleGetTask(request, env, taskId);
    if (request.method === 'PUT') return handleUpdateTask(request, env, taskId);
    if (request.method === 'DELETE') return handleDeleteTask(request, env, taskId);
  }

  // POST /api/cron/task/:id/toggle
  const toggleMatch = path.match(/^\/api\/cron\/task\/([^/]+)\/toggle$/);
  if (toggleMatch && request.method === 'POST') {
    return handleToggleTask(request, env, toggleMatch[1]);
  }

  // GET /api/cron/due
  if (path === '/api/cron/due' && request.method === 'GET') {
    const tasks = await cronHandler.getDueTasks(env);
    return new Response(JSON.stringify({ tasks }), { headers: JSON_HEADERS });
  }

  // POST /api/cron/task/:id/executed
  const executedMatch = path.match(/^\/api\/cron\/task\/([^/]+)\/executed$/);
  if (executedMatch && request.method === 'POST') {
    return handleMarkExecuted(request, env, executedMatch[1]);
  }

  return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: JSON_HEADERS });
}
