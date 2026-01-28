/**
 * Cockpit API Handler
 *
 * REST API endpoints for FUGUE Cockpit monitoring and task management.
 * Provides CRUD operations for tasks, git repos, and alerts.
 *
 * ## Endpoints
 * - GET /api/cockpit/tasks - List tasks
 * - POST /api/cockpit/tasks - Create task
 * - GET /api/cockpit/repos - List git repos
 * - GET /api/cockpit/alerts - List alerts
 * - POST /api/cockpit/alerts/ack/:id - Acknowledge alert
 */

import { z } from 'zod';
import type { Env } from '../types';
import { safeLog } from '../utils/log-sanitizer';

// =============================================================================
// Request Schemas
// =============================================================================

const CreateTaskSchema = z.object({
  id: z.string().optional(),
  title: z.string().min(1),
  executor: z.enum(['claude-code', 'codex', 'glm', 'subagent', 'gemini']).optional(),
  payload: z.unknown().optional(),
});

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Verify API key
 */
function verifyApiKey(request: Request, env: Env): boolean {
  const apiKey = env.QUEUE_API_KEY || env.ASSISTANT_API_KEY;
  if (!apiKey) {
    return true; // No key configured, allow access
  }

  const authHeader = request.headers.get('Authorization');
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  return token === apiKey;
}

/**
 * Generate task ID
 */
function generateTaskId(): string {
  return `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// =============================================================================
// Route Handlers
// =============================================================================

/**
 * GET /api/cockpit/tasks
 * List tasks with optional filters
 */
async function handleGetTasks(request: Request, env: Env): Promise<Response> {
  if (!env.DB) {
    return new Response(JSON.stringify({ error: 'Database not available' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const url = new URL(request.url);
    const status = url.searchParams.get('status');
    const executor = url.searchParams.get('executor');
    const limit = parseInt(url.searchParams.get('limit') || '50', 10);
    const offset = parseInt(url.searchParams.get('offset') || '0', 10);

    let query = 'SELECT * FROM cockpit_tasks WHERE 1=1';
    const params: any[] = [];

    if (status) {
      query += ' AND status = ?';
      params.push(status);
    }

    if (executor) {
      query += ' AND executor = ?';
      params.push(executor);
    }

    query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const stmt = env.DB.prepare(query).bind(...params);
    const result = await stmt.all();

    // Parse JSON fields
    const tasks = result.results?.map((task: any) => ({
      ...task,
      logs: task.logs ? task.logs : null,
      result: task.result ? JSON.parse(task.result) : null,
    })) || [];

    return new Response(JSON.stringify({
      tasks,
      count: tasks.length,
      limit,
      offset,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    safeLog.error('[CockpitAPI] Failed to get tasks', {
      error: error instanceof Error ? error.message : String(error),
    });
    return new Response(JSON.stringify({ error: 'Internal error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

/**
 * POST /api/cockpit/tasks
 * Create a new task
 */
async function handleCreateTask(request: Request, env: Env): Promise<Response> {
  if (!env.DB) {
    return new Response(JSON.stringify({ error: 'Database not available' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const body = await request.json();
    const validated = CreateTaskSchema.parse(body);

    const taskId = validated.id || generateTaskId();
    const now = Math.floor(Date.now() / 1000);

    await env.DB.prepare(`
      INSERT INTO cockpit_tasks (id, title, status, executor, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(
      taskId,
      validated.title,
      'pending',
      validated.executor || null,
      now,
      now
    ).run();

    safeLog.log('[CockpitAPI] Task created', {
      taskId,
      title: validated.title,
      executor: validated.executor,
    });

    // Optionally broadcast to agents via WebSocket DO
    if (env.COCKPIT_WS) {
      try {
        const doId = env.COCKPIT_WS.idFromName('cockpit');
        const doStub = env.COCKPIT_WS.get(doId);

        await doStub.fetch(new Request('http://do/broadcast-task', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'task',
            taskId,
            taskType: validated.executor || 'unknown',
            payload: validated.payload || {},
          }),
        }));

        safeLog.log('[CockpitAPI] Task broadcasted to agents', { taskId });
      } catch (error) {
        safeLog.warn('[CockpitAPI] Failed to broadcast task', {
          taskId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return new Response(JSON.stringify({
      success: true,
      taskId,
    }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return new Response(JSON.stringify({
        error: 'Validation failed',
        details: error.errors,
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    safeLog.error('[CockpitAPI] Failed to create task', {
      error: error instanceof Error ? error.message : String(error),
    });
    return new Response(JSON.stringify({ error: 'Internal error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

/**
 * GET /api/cockpit/repos
 * List git repositories
 */
async function handleGetRepos(request: Request, env: Env): Promise<Response> {
  if (!env.DB) {
    return new Response(JSON.stringify({ error: 'Database not available' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const url = new URL(request.url);
    const status = url.searchParams.get('status');
    const limit = parseInt(url.searchParams.get('limit') || '50', 10);

    let query = 'SELECT * FROM cockpit_git_repos WHERE 1=1';
    const params: any[] = [];

    if (status) {
      query += ' AND status = ?';
      params.push(status);
    }

    query += ' ORDER BY last_checked DESC LIMIT ?';
    params.push(limit);

    const stmt = env.DB.prepare(query).bind(...params);
    const result = await stmt.all();

    // Parse JSON fields
    const repos = result.results?.map((repo: any) => ({
      ...repo,
      modifiedFiles: repo.modified_files ? JSON.parse(repo.modified_files) : null,
      modified_files: undefined, // Remove snake_case field
    })) || [];

    return new Response(JSON.stringify({
      repos,
      count: repos.length,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    safeLog.error('[CockpitAPI] Failed to get repos', {
      error: error instanceof Error ? error.message : String(error),
    });
    return new Response(JSON.stringify({ error: 'Internal error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

/**
 * GET /api/cockpit/alerts
 * List alerts with optional filters
 */
async function handleGetAlerts(request: Request, env: Env): Promise<Response> {
  if (!env.DB) {
    return new Response(JSON.stringify({ error: 'Database not available' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const url = new URL(request.url);
    const severity = url.searchParams.get('severity');
    const acknowledged = url.searchParams.get('acknowledged');
    const limit = parseInt(url.searchParams.get('limit') || '100', 10);

    let query = 'SELECT * FROM cockpit_alerts WHERE 1=1';
    const params: any[] = [];

    if (severity) {
      query += ' AND severity = ?';
      params.push(severity);
    }

    if (acknowledged !== null) {
      query += ' AND acknowledged = ?';
      params.push(acknowledged === 'true' ? 1 : 0);
    }

    query += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);

    const stmt = env.DB.prepare(query).bind(...params);
    const result = await stmt.all();

    return new Response(JSON.stringify({
      alerts: result.results || [],
      count: result.results?.length || 0,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    safeLog.error('[CockpitAPI] Failed to get alerts', {
      error: error instanceof Error ? error.message : String(error),
    });
    return new Response(JSON.stringify({ error: 'Internal error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

/**
 * POST /api/cockpit/alerts/ack/:id
 * Acknowledge an alert
 */
async function handleAckAlert(request: Request, env: Env, alertId: string): Promise<Response> {
  if (!env.DB) {
    return new Response(JSON.stringify({ error: 'Database not available' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const result = await env.DB.prepare(`
      UPDATE cockpit_alerts
      SET acknowledged = 1
      WHERE id = ?
    `).bind(alertId).run();

    if (result.meta.changes === 0) {
      return new Response(JSON.stringify({ error: 'Alert not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    safeLog.log('[CockpitAPI] Alert acknowledged', { alertId });

    return new Response(JSON.stringify({
      success: true,
      alertId,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    safeLog.error('[CockpitAPI] Failed to acknowledge alert', {
      alertId,
      error: error instanceof Error ? error.message : String(error),
    });
    return new Response(JSON.stringify({ error: 'Internal error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// =============================================================================
// Main Handler
// =============================================================================

export async function handleCockpitAPI(request: Request, env: Env, path: string): Promise<Response> {
  // Verify API key
  if (!verifyApiKey(request, env)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Route requests
  if (path === '/api/cockpit/tasks' && request.method === 'GET') {
    return handleGetTasks(request, env);
  }

  if (path === '/api/cockpit/tasks' && request.method === 'POST') {
    return handleCreateTask(request, env);
  }

  if (path === '/api/cockpit/repos' && request.method === 'GET') {
    return handleGetRepos(request, env);
  }

  if (path === '/api/cockpit/alerts' && request.method === 'GET') {
    return handleGetAlerts(request, env);
  }

  const ackMatch = path.match(/^\/api\/cockpit\/alerts\/ack\/([^/]+)$/);
  if (ackMatch && request.method === 'POST') {
    return handleAckAlert(request, env, ackMatch[1]);
  }

  return new Response(JSON.stringify({ error: 'Not found' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json' },
  });
}
