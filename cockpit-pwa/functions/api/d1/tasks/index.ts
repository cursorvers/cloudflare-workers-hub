/**
 * D1 Tasks API - List & Create
 *
 * GET /api/d1/tasks - List all tasks (optional ?status=todo filter)
 * POST /api/d1/tasks - Create a new task
 */

import { TaskRepository } from '../../../lib/task-repository';
import type { Task } from '../../../lib/task-repository';

interface Env {
  DB: D1Database;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

// Validation helpers
const VALID_STATUSES = ['todo', 'in_progress', 'done', 'blocked'] as const;
const VALID_PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;

function isValidStatus(status: string): status is Task['status'] {
  return VALID_STATUSES.includes(status as Task['status']);
}

function isValidPriority(priority: string): priority is Task['priority'] {
  return VALID_PRIORITIES.includes(priority as Task['priority']);
}

export async function onRequestGet(context: { request: Request; env: Env }) {
  try {
    const url = new URL(context.request.url);
    const statusFilter = url.searchParams.get('status');

    const repo = new TaskRepository(context.env.DB);

    let tasks: Task[];
    if (statusFilter && isValidStatus(statusFilter)) {
      tasks = await repo.findByStatus(statusFilter);
    } else {
      tasks = await repo.findAll();
    }

    return new Response(
      JSON.stringify({ success: true, data: tasks }),
      { status: 200, headers: CORS_HEADERS }
    );
  } catch (error) {
    console.error('[D1 Tasks] List error:', error);
    return new Response(
      JSON.stringify({
        success: false,
        error: 'Failed to fetch tasks',
        message: error instanceof Error ? error.message : 'Unknown error',
      }),
      { status: 500, headers: CORS_HEADERS }
    );
  }
}

export async function onRequestPost(context: { request: Request; env: Env }) {
  try {
    const body = await context.request.json() as {
      title?: string;
      description?: string;
      status?: string;
      priority?: string;
      assignee?: string;
    };

    // Validate required fields
    if (!body.title || typeof body.title !== 'string' || body.title.trim().length === 0) {
      return new Response(
        JSON.stringify({ success: false, error: 'Title is required' }),
        { status: 400, headers: CORS_HEADERS }
      );
    }

    if (body.title.length > 200) {
      return new Response(
        JSON.stringify({ success: false, error: 'Title too long (max 200 chars)' }),
        { status: 400, headers: CORS_HEADERS }
      );
    }

    // Validate optional fields
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
    const newTask = await repo.create({
      title: body.title.trim(),
      description: body.description?.trim(),
      status: body.status as Task['status'] | undefined,
      priority: body.priority as Task['priority'] | undefined,
      assignee: body.assignee?.trim(),
    });

    console.log('[D1 Tasks] Created:', { id: newTask.id, title: newTask.title });

    return new Response(
      JSON.stringify({ success: true, data: newTask }),
      { status: 201, headers: CORS_HEADERS }
    );
  } catch (error) {
    console.error('[D1 Tasks] Create error:', error);
    return new Response(
      JSON.stringify({
        success: false,
        error: 'Failed to create task',
        message: error instanceof Error ? error.message : 'Unknown error',
      }),
      { status: 500, headers: CORS_HEADERS }
    );
  }
}

export async function onRequestOptions() {
  return new Response(null, { headers: CORS_HEADERS });
}
