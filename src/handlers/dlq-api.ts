/**
 * Dead Letter Queue API
 *
 * Manage failed receipt processing attempts.
 */

import type { Env } from '../types';
import {
  listDLQEntries,
  getDLQEntry,
  updateDLQStatus,
  deleteDLQEntry,
  type DLQStatus,
} from '../services/dlq';

// ============================================================================
// Handlers
// ============================================================================

/**
 * GET /api/receipts/dlq - List DLQ entries
 */
async function handleListDLQ(env: Env, url: URL): Promise<Response> {
  if (!env.DB) {
    return new Response(JSON.stringify({ error: 'Database not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const status = url.searchParams.get('status') as DLQStatus | null;
    const source = url.searchParams.get('source') as 'gmail' | 'web_scraper' | null;
    const limit = parseInt(url.searchParams.get('limit') || '50');
    const offset = parseInt(url.searchParams.get('offset') || '0');

    const result = await listDLQEntries(env, {
      status: status || undefined,
      source: source || undefined,
      limit,
      offset,
    });

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    return new Response(
      JSON.stringify({
        error: 'Failed to list DLQ entries',
        details: error instanceof Error ? error.message : String(error),
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}

/**
 * GET /api/receipts/dlq/:id - Get DLQ entry details
 */
async function handleGetDLQ(env: Env, id: string): Promise<Response> {
  if (!env.DB) {
    return new Response(JSON.stringify({ error: 'Database not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const entry = await getDLQEntry(env, id);

    if (!entry) {
      return new Response(JSON.stringify({ error: 'DLQ entry not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify(entry), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    return new Response(
      JSON.stringify({
        error: 'Failed to get DLQ entry',
        details: error instanceof Error ? error.message : String(error),
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}

/**
 * PATCH /api/receipts/dlq/:id - Update DLQ entry status
 */
async function handleUpdateDLQ(
  env: Env,
  id: string,
  request: Request
): Promise<Response> {
  if (!env.DB) {
    return new Response(JSON.stringify({ error: 'Database not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const body = await request.json();
    const { status, resolutionNote } = body as {
      status?: DLQStatus;
      resolutionNote?: string;
    };

    if (!status) {
      return new Response(JSON.stringify({ error: 'Status is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Validate status
    const validStatuses: DLQStatus[] = ['pending', 'retrying', 'resolved', 'abandoned'];
    if (!validStatuses.includes(status)) {
      return new Response(
        JSON.stringify({
          error: 'Invalid status',
          validStatuses,
        }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    await updateDLQStatus(env, id, status, resolutionNote);

    return new Response(
      JSON.stringify({ success: true, id, status }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({
        error: 'Failed to update DLQ entry',
        details: error instanceof Error ? error.message : String(error),
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}

/**
 * DELETE /api/receipts/dlq/:id - Delete DLQ entry
 */
async function handleDeleteDLQ(env: Env, id: string): Promise<Response> {
  if (!env.DB) {
    return new Response(JSON.stringify({ error: 'Database not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    await deleteDLQEntry(env, id);

    return new Response(
      JSON.stringify({ success: true, id }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({
        error: 'Failed to delete DLQ entry',
        details: error instanceof Error ? error.message : String(error),
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}

/**
 * POST /api/receipts/dlq/:id/retry - Retry failed item
 */
async function handleRetryDLQ(env: Env, id: string): Promise<Response> {
  if (!env.DB) {
    return new Response(JSON.stringify({ error: 'Database not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    // Get DLQ entry
    const entry = await getDLQEntry(env, id);

    if (!entry) {
      return new Response(JSON.stringify({ error: 'DLQ entry not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Update status to retrying
    await updateDLQStatus(env, id, 'retrying', 'Manual retry triggered');

    // TODO: Re-process the failed item
    // This would involve calling the appropriate processing function
    // based on entry.source (gmail or web_scraper)

    return new Response(
      JSON.stringify({
        success: true,
        id,
        message: 'Retry triggered. Check logs for result.',
      }),
      {
        status: 202, // Accepted
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({
        error: 'Failed to retry DLQ entry',
        details: error instanceof Error ? error.message : String(error),
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}

// ============================================================================
// Router
// ============================================================================

export async function handleDLQAPI(
  request: Request,
  env: Env,
  path: string
): Promise<Response> {
  const url = new URL(request.url);
  const pathSegments = path.replace('/api/receipts/dlq', '').split('/').filter(Boolean);

  // GET /api/receipts/dlq
  if (request.method === 'GET' && pathSegments.length === 0) {
    return handleListDLQ(env, url);
  }

  // GET /api/receipts/dlq/:id
  if (request.method === 'GET' && pathSegments.length === 1) {
    return handleGetDLQ(env, pathSegments[0]);
  }

  // PATCH /api/receipts/dlq/:id
  if (request.method === 'PATCH' && pathSegments.length === 1) {
    return handleUpdateDLQ(env, pathSegments[0], request);
  }

  // DELETE /api/receipts/dlq/:id
  if (request.method === 'DELETE' && pathSegments.length === 1) {
    return handleDeleteDLQ(env, pathSegments[0]);
  }

  // POST /api/receipts/dlq/:id/retry
  if (request.method === 'POST' && pathSegments.length === 2 && pathSegments[1] === 'retry') {
    return handleRetryDLQ(env, pathSegments[0]);
  }

  return new Response(JSON.stringify({ error: 'Not found' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json' },
  });
}
