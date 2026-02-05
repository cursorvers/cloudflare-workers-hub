/**
 * D1 Tasks API - Bulk Status Update
 *
 * PATCH /api/d1/tasks/bulk-status - Update multiple tasks' status
 */

import { TaskRepository } from '../../../lib/task-repository';
import type { Task } from '../../../lib/task-repository';

interface Env {
  DB: D1Database;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'PATCH, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

const VALID_STATUSES = ['todo', 'in_progress', 'done', 'blocked'] as const;

function isValidStatus(status: string): status is Task['status'] {
  return VALID_STATUSES.includes(status as Task['status']);
}

export async function onRequestPatch(context: { request: Request; env: Env }) {
  try {
    const body = await context.request.json() as {
      ids?: number[];
      status?: string;
    };

    // Validate IDs
    if (!body.ids || !Array.isArray(body.ids) || body.ids.length === 0) {
      return new Response(
        JSON.stringify({ success: false, error: 'At least one task ID is required' }),
        { status: 400, headers: CORS_HEADERS }
      );
    }

    // Validate all IDs are positive integers
    const validIds = body.ids.every(
      (id) => typeof id === 'number' && Number.isInteger(id) && id > 0
    );
    if (!validIds) {
      return new Response(
        JSON.stringify({ success: false, error: 'All IDs must be positive integers' }),
        { status: 400, headers: CORS_HEADERS }
      );
    }

    // Validate status
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
    const count = await repo.bulkUpdateStatus(body.ids, body.status);

    console.log('[D1 Tasks] Bulk status update:', {
      ids: body.ids,
      status: body.status,
      updated: count,
    });

    return new Response(
      JSON.stringify({
        success: true,
        data: { updated: count },
        message: `${count} task(s) updated`,
      }),
      { status: 200, headers: CORS_HEADERS }
    );
  } catch (error) {
    console.error('[D1 Tasks] Bulk status update error:', error);
    return new Response(
      JSON.stringify({
        success: false,
        error: 'Failed to update tasks',
        message: error instanceof Error ? error.message : 'Unknown error',
      }),
      { status: 500, headers: CORS_HEADERS }
    );
  }
}

export async function onRequestOptions() {
  return new Response(null, { headers: CORS_HEADERS });
}
