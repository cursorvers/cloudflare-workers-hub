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

export async function handleCronAPI(request: Request, env: Env, path: string): Promise<Response> {
  // Verify API key with admin scope
  if (!verifyAPIKey(request, env, 'admin')) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Rate limit check
  const apiKey = request.headers.get('Authorization')?.replace('Bearer ', '') || request.headers.get('X-API-Key') || '';
  const rateLimitResult = await checkRateLimit(env, 'admin', apiKey.substring(0, 8));
  if (!rateLimitResult.allowed) {
    return createRateLimitResponse(rateLimitResult);
  }

  // GET /api/cron/tasks/:userId - Get user's scheduled tasks
  const userTasksMatch = path.match(/^\/api\/cron\/tasks\/([^/]+)$/);
  if (userTasksMatch && request.method === 'GET') {
    const userId = userTasksMatch[1];

    // SECURITY: Validate userId format
    const validation = validatePathParameter(userId, UserIdPathSchema, 'userId', '/api/cron/tasks/:userId');
    if (!validation.success) {
      return validation.response;
    }

    // SECURITY: Verify that the API key is authorized to access this userId
    if (!await authorizeUserAccess(request, userId, env)) {
      safeLog.warn('[Cron API] Unauthorized access attempt', {
        endpoint: '/tasks',
        requestedUserId: maskUserId(userId),
      });
      return new Response(JSON.stringify({ error: 'Forbidden' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const tasks = await cronHandler.getScheduledTasks(env, userId);
    return new Response(JSON.stringify({ tasks }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // POST /api/cron/tasks - Create scheduled task
  if (path === '/api/cron/tasks' && request.method === 'POST') {
    const validation = await validateRequestBody(request, CreateTaskSchema, '/api/cron/tasks');
    if (!validation.success) {
      return validation.response;
    }

    const input = validation.data as CreateTaskInput;

    // SECURITY: Verify that the API key is authorized to create tasks for this userId
    if (!await authorizeUserAccess(request, input.user_id, env)) {
      safeLog.warn('[Cron API] Unauthorized access attempt', {
        endpoint: '/tasks (POST)',
        requestedUserId: maskUserId(input.user_id),
      });
      return new Response(JSON.stringify({ error: 'Forbidden' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    try {
      const task = await cronHandler.createScheduledTask(env, input);
      return new Response(JSON.stringify({ success: true, task }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      safeLog.error('[Cron API] Task creation failed', {
        endpoint: '/tasks (POST)',
        error: String(error),
      });
      return new Response(JSON.stringify({
        error: 'Failed to create scheduled task',
        type: 'validation_error',
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  // GET /api/cron/task/:id - Get single task
  const taskMatch = path.match(/^\/api\/cron\/task\/([^/]+)$/);
  if (taskMatch && request.method === 'GET') {
    const taskId = taskMatch[1];

    // SECURITY: Validate taskId format
    const validation = validatePathParameter(taskId, TaskIdPathSchema, 'taskId', '/api/cron/task/:id');
    if (!validation.success) {
      return validation.response;
    }

    const task = await cronHandler.getTaskById(env, taskId);
    if (!task) {
      return new Response(JSON.stringify({ error: 'Task not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // SECURITY: Verify that the API key is authorized to access this task's userId
    if (!await authorizeUserAccess(request, task.user_id, env)) {
      safeLog.warn('[Cron API] Unauthorized access attempt', {
        endpoint: '/task (GET)',
        taskId,
        taskUserId: maskUserId(task.user_id),
      });
      return new Response(JSON.stringify({ error: 'Forbidden' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ task }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // PUT /api/cron/task/:id - Update task
  if (taskMatch && request.method === 'PUT') {
    const taskId = taskMatch[1];

    // SECURITY: Validate taskId format
    const taskIdValidation = validatePathParameter(taskId, TaskIdPathSchema, 'taskId', '/api/cron/task/:id');
    if (!taskIdValidation.success) {
      return taskIdValidation.response;
    }

    // Fetch task first to verify ownership
    const existingTask = await cronHandler.getTaskById(env, taskId);
    if (!existingTask) {
      return new Response(JSON.stringify({ error: 'Task not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // SECURITY: Verify that the API key is authorized to update this task's userId
    if (!await authorizeUserAccess(request, existingTask.user_id, env)) {
      safeLog.warn('[Cron API] Unauthorized access attempt', {
        endpoint: '/task (PUT)',
        taskId,
        taskUserId: maskUserId(existingTask.user_id),
      });
      return new Response(JSON.stringify({ error: 'Forbidden' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const validation = await validateRequestBody(request, UpdateTaskSchema, '/api/cron/task/:id');
    if (!validation.success) {
      return validation.response;
    }

    const updates = validation.data as UpdateTaskInput;
    const task = await cronHandler.updateScheduledTask(env, taskId, updates);
    return new Response(JSON.stringify({ success: true, task }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // DELETE /api/cron/task/:id - Delete task
  if (taskMatch && request.method === 'DELETE') {
    const taskId = taskMatch[1];

    // SECURITY: Validate taskId format
    const taskIdValidation = validatePathParameter(taskId, TaskIdPathSchema, 'taskId', '/api/cron/task/:id');
    if (!taskIdValidation.success) {
      return taskIdValidation.response;
    }

    // Fetch task first to verify ownership
    const existingTask = await cronHandler.getTaskById(env, taskId);
    if (!existingTask) {
      return new Response(JSON.stringify({ error: 'Task not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // SECURITY: Verify that the API key is authorized to delete this task's userId
    if (!await authorizeUserAccess(request, existingTask.user_id, env)) {
      safeLog.warn('[Cron API] Unauthorized access attempt', {
        endpoint: '/task (DELETE)',
        taskId,
        taskUserId: maskUserId(existingTask.user_id),
      });
      return new Response(JSON.stringify({ error: 'Forbidden' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const deleted = await cronHandler.deleteScheduledTask(env, taskId);
    return new Response(JSON.stringify({ success: deleted }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // POST /api/cron/task/:id/toggle - Toggle task enabled status
  const toggleMatch = path.match(/^\/api\/cron\/task\/([^/]+)\/toggle$/);
  if (toggleMatch && request.method === 'POST') {
    const taskId = toggleMatch[1];

    // SECURITY: Validate taskId format
    const validation = validatePathParameter(taskId, TaskIdPathSchema, 'taskId', '/api/cron/task/:id/toggle');
    if (!validation.success) {
      return validation.response;
    }

    // Fetch task first to verify ownership
    const existingTask = await cronHandler.getTaskById(env, taskId);
    if (!existingTask) {
      return new Response(JSON.stringify({ error: 'Task not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // SECURITY: Verify that the API key is authorized to toggle this task's userId
    if (!await authorizeUserAccess(request, existingTask.user_id, env)) {
      safeLog.warn('[Cron API] Unauthorized access attempt', {
        endpoint: '/task/toggle',
        taskId,
        taskUserId: maskUserId(existingTask.user_id),
      });
      return new Response(JSON.stringify({ error: 'Forbidden' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const task = await cronHandler.toggleTaskEnabled(env, taskId);
    return new Response(JSON.stringify({ success: true, task }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // GET /api/cron/due - Get all due tasks (for daemon polling)
  if (path === '/api/cron/due' && request.method === 'GET') {
    const tasks = await cronHandler.getDueTasks(env);
    return new Response(JSON.stringify({ tasks }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // POST /api/cron/task/:id/executed - Mark task as executed
  const executedMatch = path.match(/^\/api\/cron\/task\/([^/]+)\/executed$/);
  if (executedMatch && request.method === 'POST') {
    const taskId = executedMatch[1];

    // SECURITY: Validate taskId format
    const validation = validatePathParameter(taskId, TaskIdPathSchema, 'taskId', '/api/cron/task/:id/executed');
    if (!validation.success) {
      return validation.response;
    }

    // Fetch task first to verify ownership
    const existingTask = await cronHandler.getTaskById(env, taskId);
    if (!existingTask) {
      return new Response(JSON.stringify({ error: 'Task not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // SECURITY: Verify that the API key is authorized to mark execution for this task's userId
    if (!await authorizeUserAccess(request, existingTask.user_id, env)) {
      safeLog.warn('[Cron API] Unauthorized access attempt', {
        endpoint: '/task/executed',
        taskId,
        taskUserId: maskUserId(existingTask.user_id),
      });
      return new Response(JSON.stringify({ error: 'Forbidden' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const task = await cronHandler.markTaskExecuted(env, taskId);
    return new Response(JSON.stringify({ success: true, task }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ error: 'Not found' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json' },
  });
}
