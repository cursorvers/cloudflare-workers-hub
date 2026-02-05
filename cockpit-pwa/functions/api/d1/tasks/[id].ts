/**
 * D1 Tasks API - Single Task Operations
 *
 * GET /api/d1/tasks/:id - Get task by ID
 * PUT /api/d1/tasks/:id - Update task
 * DELETE /api/d1/tasks/:id - Delete task
 * PATCH /api/d1/tasks/:id - Update task status only
 */

import { TaskRepository } from '../../../lib/task-repository';
import type { Task } from '../../../lib/task-repository';

interface Env {
  DB: D1Database;
}

interface Context {
  request: Request;
  env: Env;
  params: { id: string };
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

const VALID_STATUSES = ['todo', 'in_progress', 'done', 'blocked'] as const;
const VALID_PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;

function isValidStatus(status: string): status is Task['status'] {
  return VALID_STATUSES.includes(status as Task['status']);
}

function isValidPriority(priority: string): priority is Task['priority'] {
  return VALID_PRIORITIES.includes(priority as Task['priority']);
}

function parseId(idParam: string): number | null {
  const id = parseInt(idParam, 10);
  return isNaN(id) || id <= 0 ? null : id;
}

export async function onRequestGet(context: Context) {
  try {
    const id = parseId(context.params.id);
    if (!id) {
      return new Response(
        JSON.stringify({ success: false, error: 'Invalid task ID' }),
        { status: 400, headers: CORS_HEADERS }
      );
    }

    const repo = new TaskRepository(context.env.DB);
    const task = await repo.findById(id);

    if (!task) {
      return new Response(
        JSON.stringify({ success: false, error: 'Task not found' }),
        { status: 404, headers: CORS_HEADERS }
      );
    }

    return new Response(
      JSON.stringify({ success: true, data: task }),
      { status: 200, headers: CORS_HEADERS }
    );
  } catch (error) {
    console.error('[D1 Tasks] Get error:', error);
    return new Response(
      JSON.stringify({
        success: false,
        error: 'Failed to fetch task',
        message: error instanceof Error ? error.message : 'Unknown error',
      }),
      { status: 500, headers: CORS_HEADERS }
    );
  }
}

export async function onRequestPut(context: Context) {
  try {
    const id = parseId(context.params.id);
    if (!id) {
      return new Response(
        JSON.stringify({ success: false, error: 'Invalid task ID' }),
        { status: 400, headers: CORS_HEADERS }
      );
    }

    const body = await context.request.json() as {
      title?: string;
      description?: string;
      status?: string;
      priority?: string;
      assignee?: string;
    };

    // Validate fields if provided
    if (body.title !== undefined) {
      if (typeof body.title !== 'string' || body.title.trim().length === 0) {
        return new Response(
          JSON.stringify({ success: false, error: 'Title cannot be empty' }),
          { status: 400, headers: CORS_HEADERS }
        );
      }
      if (body.title.length > 200) {
        return new Response(
          JSON.stringify({ success: false, error: 'Title too long (max 200 chars)' }),
          { status: 400, headers: CORS_HEADERS }
        );
      }
    }

    if (body.status && !isValidStatus(body.status)) {
      return new Response(
        JSON.stringify({
          success: false,
          error: `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}`,
        }),
        { status: 400, headers: CORS_HEADERS }
      );
    }

    if (body.priority && !isValidPriority(body.priority)) {
      return new Response(
        JSON.stringify({
          success: false,
          error: `Invalid priority. Must be one of: ${VALID_PRIORITIES.join(', ')}`,
        }),
        { status: 400, headers: CORS_HEADERS }
      );
    }

    const repo = new TaskRepository(context.env.DB);
    const updated = await repo.update(id, {
      title: body.title?.trim(),
      description: body.description?.trim(),
      status: body.status as Task['status'] | undefined,
      priority: body.priority as Task['priority'] | undefined,
      assignee: body.assignee?.trim(),
    });

    if (!updated) {
      return new Response(
        JSON.stringify({ success: false, error: 'Task not found' }),
        { status: 404, headers: CORS_HEADERS }
      );
    }

    console.log('[D1 Tasks] Updated:', { id: updated.id, title: updated.title });

    return new Response(
      JSON.stringify({ success: true, data: updated }),
      { status: 200, headers: CORS_HEADERS }
    );
  } catch (error) {
    console.error('[D1 Tasks] Update error:', error);
    return new Response(
      JSON.stringify({
        success: false,
        error: 'Failed to update task',
        message: error instanceof Error ? error.message : 'Unknown error',
      }),
      { status: 500, headers: CORS_HEADERS }
    );
  }
}

export async function onRequestPatch(context: Context) {
  try {
    const id = parseId(context.params.id);
    if (!id) {
      return new Response(
        JSON.stringify({ success: false, error: 'Invalid task ID' }),
        { status: 400, headers: CORS_HEADERS }
      );
    }

    const body = await context.request.json() as { status?: string };

    if (!body.status || !isValidStatus(body.status)) {
      return new Response(
        JSON.stringify({
          success: false,
          error: `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}`,
        }),
        { status: 400, headers: CORS_HEADERS }
      );
    }

    const repo = new TaskRepository(context.env.DB);
    const updated = await repo.updateStatus(id, body.status);

    if (!updated) {
      return new Response(
        JSON.stringify({ success: false, error: 'Task not found' }),
        { status: 404, headers: CORS_HEADERS }
      );
    }

    console.log('[D1 Tasks] Status updated:', { id: updated.id, status: updated.status });

    return new Response(
      JSON.stringify({ success: true, data: updated }),
      { status: 200, headers: CORS_HEADERS }
    );
  } catch (error) {
    console.error('[D1 Tasks] Status update error:', error);
    return new Response(
      JSON.stringify({
        success: false,
        error: 'Failed to update task status',
        message: error instanceof Error ? error.message : 'Unknown error',
      }),
      { status: 500, headers: CORS_HEADERS }
    );
  }
}

export async function onRequestDelete(context: Context) {
  try {
    const id = parseId(context.params.id);
    if (!id) {
      return new Response(
        JSON.stringify({ success: false, error: 'Invalid task ID' }),
        { status: 400, headers: CORS_HEADERS }
      );
    }

    const repo = new TaskRepository(context.env.DB);
    const deleted = await repo.delete(id);

    if (!deleted) {
      return new Response(
        JSON.stringify({ success: false, error: 'Task not found' }),
        { status: 404, headers: CORS_HEADERS }
      );
    }

    console.log('[D1 Tasks] Deleted:', { id });

    return new Response(
      JSON.stringify({ success: true, message: 'Task deleted' }),
      { status: 200, headers: CORS_HEADERS }
    );
  } catch (error) {
    console.error('[D1 Tasks] Delete error:', error);
    return new Response(
      JSON.stringify({
        success: false,
        error: 'Failed to delete task',
        message: error instanceof Error ? error.message : 'Unknown error',
      }),
      { status: 500, headers: CORS_HEADERS }
    );
  }
}

export async function onRequestOptions() {
  return new Response(null, { headers: CORS_HEADERS });
}
