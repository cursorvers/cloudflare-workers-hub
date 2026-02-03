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
import {
  authenticateRequest,
  authorizeRequest,
  generateAccessToken,
  generateRefreshToken,
  verifyRefreshToken,
  rotateRefreshToken,
  getUserRole,
  type UserRole,
} from '../utils/jwt-auth';
import {
  authenticateWithAccess,
  mapAccessUserToInternal,
} from '../utils/cloudflare-access';
import { handleSubscribe, handleUnsubscribe } from './push-notifications';
import {
  validateOrigin,
  createCSRFErrorResponse,
} from '../utils/csrf-protection';
import {
  checkRateLimit,
  createRateLimitErrorResponse,
  addRateLimitHeaders,
} from '../utils/rate-limiter';
import {
  hashPassword,
  verifyPassword,
  PasswordSchema,
} from '../utils/password-auth';

// =============================================================================
// Request Schemas
// =============================================================================

const CreateTaskSchema = z.object({
  id: z.string().optional(),
  title: z.string().min(1),
  executor: z.enum(['claude-code', 'codex', 'glm', 'subagent', 'gemini']).optional(),
  payload: z.unknown().optional(),
  status: z.enum(['backlog', 'pending', 'in_progress', 'review', 'completed']).optional(),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
  description: z.string().optional(),
});

const UpdateTaskSchema = z.object({
  title: z.string().min(1).optional(),
  status: z.enum(['backlog', 'pending', 'in_progress', 'review', 'completed']).optional(),
  executor: z.enum(['claude-code', 'codex', 'glm', 'subagent', 'gemini']).nullable().optional(),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
  description: z.string().optional(),
  result: z.unknown().optional(),
});

const LoginSchema = z.object({
  email: z.string().email(),
  password: PasswordSchema, // Password with strength validation
});

const RefreshTokenSchema = z.object({
  refreshToken: z.string().min(1),
});

const PushSubscriptionSchema = z.object({
  subscription: z.object({
    endpoint: z.string().url(),
    keys: z.object({
      p256dh: z.string(),
      auth: z.string(),
    }),
  }),
  userId: z.string().optional(),
});

const UnsubscribeSchema = z.object({
  endpoint: z.string().url(),
});

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Authentication & Authorization Middleware
 *
 * Authentication priority:
 * 1. Cloudflare Access JWT (Cf-Access-Jwt-Assertion header) - Zero Trust authentication
 * 2. Standard JWT (Authorization: Bearer) - Fallback for API clients and migration period
 *
 * This dual-auth approach allows:
 * - PWA users to authenticate via Google SSO through Cloudflare Access
 * - API clients to continue using existing JWT authentication
 * - Gradual migration without breaking existing integrations
 */
async function authenticateAndAuthorize(
  request: Request,
  env: Env
): Promise<{ success: boolean; userId?: string; role?: UserRole; response?: Response }> {
  // CSRF Protection: Validate Origin/Referer for state-changing requests
  const csrfResult = validateOrigin(request, env);
  if (!csrfResult.valid) {
    safeLog.warn('[CSRF] Request rejected', {
      method: request.method,
      url: request.url,
      error: csrfResult.error,
    });
    return {
      success: false,
      response: createCSRFErrorResponse(csrfResult),
    };
  }

  // Rate Limiting: Check before authentication (prevents auth bypass via brute force)
  const rateLimitResult = await checkRateLimit(request, env);
  if (!rateLimitResult.allowed) {
    safeLog.warn('[RateLimit] Request rejected', {
      method: request.method,
      url: request.url,
      remaining: rateLimitResult.remaining,
      retryAfter: rateLimitResult.retryAfter,
    });
    return {
      success: false,
      response: createRateLimitErrorResponse(rateLimitResult),
    };
  }

  let userId: string | undefined;
  let role: UserRole | undefined;
  let authMethod: 'access' | 'jwt' | undefined;

  // Try Cloudflare Access authentication first (Zero Trust)
  const accessResult = await authenticateWithAccess(request, env);
  if (accessResult.verified && accessResult.email) {
    // Map Access user to internal user for RBAC
    const internalUser = await mapAccessUserToInternal(accessResult.email, env);
    if (internalUser) {
      userId = internalUser.userId;
      role = internalUser.role as UserRole;
      authMethod = 'access';
      safeLog.log('[Auth] Authenticated via Cloudflare Access', {
        email: accessResult.email,
        userId,
        role,
        roleType: typeof role,
        roleLength: role?.length,
      });
    } else {
      // User authenticated with Access but not found in our system
      safeLog.warn('[Auth] Access user not found in system', {
        email: accessResult.email,
      });
      return {
        success: false,
        response: new Response(
          JSON.stringify({
            error: 'User not registered',
            message: 'Your account is authenticated but not registered in the system.',
          }),
          {
            status: 403,
            headers: { 'Content-Type': 'application/json' },
          }
        ),
      };
    }
  }

  // Fallback to standard JWT authentication if Access didn't succeed
  if (!userId || !role) {
    const authResult = await authenticateRequest(request, env);
    if (!authResult.authenticated) {
      return {
        success: false,
        response: new Response(JSON.stringify({ error: authResult.error || 'Unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }),
      };
    }
    userId = authResult.userId;
    role = authResult.role;
    authMethod = 'jwt';
    safeLog.log('[Auth] Authenticated via JWT', { userId, role });
  }

  // Authorize (check RBAC)
  safeLog.log('[Auth] Calling authorizeRequest', { userId, role, method: request.method, url: request.url });
  const authzResult = await authorizeRequest(request, userId!, role!);
  safeLog.log('[Auth] authorizeRequest result', { authzResult });
  if (!authzResult.authorized) {
    // Log to audit trail
    await logAuditEvent(env, {
      userId: userId!,
      action: 'access_denied',
      endpoint: new URL(request.url).pathname,
      method: request.method,
      status: 'denied',
      errorMessage: authzResult.error,
    });

    return {
      success: false,
      response: new Response(JSON.stringify({ error: authzResult.error || 'Forbidden' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      }),
    };
  }

  // Log successful access with auth method
  await logAuditEvent(env, {
    userId: userId!,
    action: `access_granted_via_${authMethod}`,
    endpoint: new URL(request.url).pathname,
    method: request.method,
    status: 'success',
  });

  return { success: true, userId, role };
}

/**
 * Log audit event
 */
async function logAuditEvent(
  env: Env,
  event: {
    userId: string;
    action: string;
    endpoint: string;
    method: string;
    status: 'success' | 'denied' | 'error';
    errorMessage?: string;
  }
): Promise<void> {
  if (!env.DB) return;

  try {
    await env.DB.prepare(`
      INSERT INTO cockpit_audit_log (user_id, action, endpoint, method, status, error_message)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(
      event.userId,
      event.action,
      event.endpoint,
      event.method,
      event.status,
      event.errorMessage || null
    ).run();
  } catch (error) {
    safeLog.error('[Audit] Failed to log event', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Generate task ID
 */
function generateTaskId(): string {
  return `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// =============================================================================
// Authentication Route Handlers
// =============================================================================

/**
 * POST /api/cockpit/auth/login
 * Issue JWT tokens (simplified - add proper password auth in production)
 */
async function handleLogin(request: Request, env: Env): Promise<Response> {
  if (!env.DB) {
    return new Response(JSON.stringify({ error: 'Database not available' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const body = await request.json();
    const validated = LoginSchema.parse(body);

    // Look up user by email (include password_hash for verification)
    const user = await env.DB.prepare(`
      SELECT user_id, role, is_active, password_hash FROM cockpit_users WHERE email = ?
    `).bind(validated.email).first<{ user_id: string; role: UserRole; is_active: number; password_hash: string | null }>();

    if (!user || !user.is_active) {
      return new Response(JSON.stringify({ error: 'Invalid credentials' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Verify password (only if password_hash exists)
    if (user.password_hash) {
      const isValidPassword = await verifyPassword(validated.password, user.password_hash);
      if (!isValidPassword) {
        safeLog.warn('[Auth] Invalid password attempt', { email: validated.email });
        return new Response(JSON.stringify({ error: 'Invalid credentials' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    } else {
      // User exists but has no password_hash (legacy Cloudflare Access user)
      // Reject password login for these users
      safeLog.warn('[Auth] Password login attempted for Access-only user', { email: validated.email });
      return new Response(JSON.stringify({
        error: 'Password authentication not configured',
        message: 'Please use Google SSO via Cloudflare Access',
      }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Generate tokens
    const accessToken = await generateAccessToken(user.user_id, user.role, env);
    const refreshToken = await generateRefreshToken(user.user_id, env);

    safeLog.log('[Auth] User logged in', { userId: user.user_id });

    return new Response(JSON.stringify({
      accessToken,
      refreshToken,
      expiresIn: 900, // 15 minutes in seconds
      user: {
        id: user.user_id,
        role: user.role,
      },
    }), {
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

    safeLog.error('[Auth] Login failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return new Response(JSON.stringify({ error: 'Internal error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

/**
 * POST /api/cockpit/auth/refresh
 * Rotate refresh token and issue new access token
 */
async function handleRefreshToken(request: Request, env: Env): Promise<Response> {
  if (!env.DB) {
    return new Response(JSON.stringify({ error: 'Database not available' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const body = await request.json();
    const validated = RefreshTokenSchema.parse(body);

    // Verify and rotate refresh token
    const newRefreshToken = await rotateRefreshToken(validated.refreshToken, env);
    if (!newRefreshToken) {
      return new Response(JSON.stringify({ error: 'Invalid refresh token' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Get user role
    const userId = await verifyRefreshToken(newRefreshToken, env);
    if (!userId) {
      return new Response(JSON.stringify({ error: 'Invalid refresh token' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const role = await getUserRole(userId, env);
    if (!role) {
      return new Response(JSON.stringify({ error: 'User not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Generate new access token
    const accessToken = await generateAccessToken(userId, role, env);

    safeLog.log('[Auth] Token refreshed', { userId });

    return new Response(JSON.stringify({
      accessToken,
      refreshToken: newRefreshToken,
      expiresIn: 900, // 15 minutes in seconds
    }), {
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

    safeLog.error('[Auth] Token refresh failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return new Response(JSON.stringify({ error: 'Internal error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// =============================================================================
// Resource Route Handlers
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
 * GET /api/cockpit/tasks/:id
 * Get a single task by ID
 */
async function handleGetTask(request: Request, env: Env, taskId: string): Promise<Response> {
  if (!env.DB) {
    return new Response(JSON.stringify({ error: 'Database not available' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const task = await env.DB.prepare(`
      SELECT * FROM cockpit_tasks WHERE id = ?
    `).bind(taskId).first();

    if (!task) {
      return new Response(JSON.stringify({ error: 'Task not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({
      task: {
        ...task,
        result: task.result ? JSON.parse(task.result as string) : null,
      },
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    safeLog.error('[CockpitAPI] Failed to get task', {
      taskId,
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
      INSERT INTO cockpit_tasks (id, title, status, executor, priority, description, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      taskId,
      validated.title,
      validated.status || 'backlog',
      validated.executor || null,
      validated.priority || 'medium',
      validated.description || null,
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
 * PUT /api/cockpit/tasks/:id
 * Update an existing task
 */
async function handleUpdateTask(request: Request, env: Env, taskId: string): Promise<Response> {
  if (!env.DB) {
    return new Response(JSON.stringify({ error: 'Database not available' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const body = await request.json();
    const validated = UpdateTaskSchema.parse(body);

    // Check if task exists
    const existing = await env.DB.prepare(`
      SELECT id FROM cockpit_tasks WHERE id = ?
    `).bind(taskId).first();

    if (!existing) {
      return new Response(JSON.stringify({ error: 'Task not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Build dynamic update query
    const updates: string[] = [];
    const values: (string | number | null)[] = [];

    if (validated.title !== undefined) {
      updates.push('title = ?');
      values.push(validated.title);
    }
    if (validated.status !== undefined) {
      updates.push('status = ?');
      values.push(validated.status);
    }
    if (validated.executor !== undefined) {
      updates.push('executor = ?');
      values.push(validated.executor);
    }
    if (validated.priority !== undefined) {
      updates.push('priority = ?');
      values.push(validated.priority);
    }
    if (validated.description !== undefined) {
      updates.push('description = ?');
      values.push(validated.description);
    }
    if (validated.result !== undefined) {
      updates.push('result = ?');
      values.push(JSON.stringify(validated.result));
    }

    if (updates.length === 0) {
      return new Response(JSON.stringify({ error: 'No fields to update' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Always update updated_at
    updates.push('updated_at = ?');
    values.push(Math.floor(Date.now() / 1000));
    values.push(taskId);

    await env.DB.prepare(`
      UPDATE cockpit_tasks SET ${updates.join(', ')} WHERE id = ?
    `).bind(...values).run();

    safeLog.log('[CockpitAPI] Task updated', {
      taskId,
      fields: Object.keys(validated),
    });

    // Broadcast update to WebSocket clients
    if (env.COCKPIT_WS) {
      try {
        const doId = env.COCKPIT_WS.idFromName('cockpit');
        const doStub = env.COCKPIT_WS.get(doId);

        await doStub.fetch(new Request('http://do/broadcast-task', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'task_update',
            taskId,
            changes: validated,
          }),
        }));
      } catch (error) {
        safeLog.warn('[CockpitAPI] Failed to broadcast task update', {
          taskId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return new Response(JSON.stringify({
      success: true,
      taskId,
    }), {
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

    safeLog.error('[CockpitAPI] Failed to update task', {
      taskId,
      error: error instanceof Error ? error.message : String(error),
    });
    return new Response(JSON.stringify({ error: 'Internal error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

/**
 * DELETE /api/cockpit/tasks/:id
 * Delete a task
 */
async function handleDeleteTask(request: Request, env: Env, taskId: string): Promise<Response> {
  if (!env.DB) {
    return new Response(JSON.stringify({ error: 'Database not available' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const result = await env.DB.prepare(`
      DELETE FROM cockpit_tasks WHERE id = ?
    `).bind(taskId).run();

    if (result.meta.changes === 0) {
      return new Response(JSON.stringify({ error: 'Task not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    safeLog.log('[CockpitAPI] Task deleted', { taskId });

    // Broadcast deletion to WebSocket clients
    if (env.COCKPIT_WS) {
      try {
        const doId = env.COCKPIT_WS.idFromName('cockpit');
        const doStub = env.COCKPIT_WS.get(doId);

        await doStub.fetch(new Request('http://do/broadcast-task', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'task_delete',
            taskId,
          }),
        }));
      } catch (error) {
        safeLog.warn('[CockpitAPI] Failed to broadcast task deletion', {
          taskId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return new Response(JSON.stringify({
      success: true,
      taskId,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    safeLog.error('[CockpitAPI] Failed to delete task', {
      taskId,
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
  // Auth endpoints (no JWT required)
  if (path === '/api/cockpit/auth/login' && request.method === 'POST') {
    return handleLogin(request, env);
  }

  if (path === '/api/cockpit/auth/refresh' && request.method === 'POST') {
    return handleRefreshToken(request, env);
  }

  // Push notification subscription endpoints (public - no auth required for PWA)
  if (path === '/api/cockpit/subscribe' && request.method === 'POST') {
    return handleSubscribe(request, env);
  }

  if (path === '/api/cockpit/unsubscribe' && request.method === 'POST') {
    return handleUnsubscribe(request, env);
  }

  // All other endpoints require JWT authentication
  const authResult = await authenticateAndAuthorize(request, env);
  if (!authResult.success) {
    return authResult.response!;
  }

  // Route requests (all protected by JWT + RBAC)

  // Task endpoints with :id parameter
  const taskIdMatch = path.match(/^\/api\/cockpit\/tasks\/([^/]+)$/);
  if (taskIdMatch) {
    const taskId = taskIdMatch[1];
    if (request.method === 'GET') {
      return handleGetTask(request, env, taskId);
    }
    if (request.method === 'PUT') {
      return handleUpdateTask(request, env, taskId);
    }
    if (request.method === 'DELETE') {
      return handleDeleteTask(request, env, taskId);
    }
  }

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
