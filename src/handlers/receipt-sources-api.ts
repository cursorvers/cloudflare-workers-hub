/**
 * Web Receipt Sources API
 *
 * Manage registered web scraping sources.
 */

import type { Env } from '../types';
import { z } from 'zod';

// ============================================================================
// Schemas
// ============================================================================

const WebReceiptSourceSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  enabled: z.number().min(0).max(1),
  url: z.string().url(),
  schedule_frequency: z.string(),
  schedule_day_of_month: z.number().nullable(),
  schedule_hour: z.number(),
  last_run_at: z.string().nullable(),
  last_run_status: z.string().nullable(),
  last_run_receipts_count: z.number(),
  last_error: z.string().nullable(),
  total_runs: z.number(),
  total_receipts: z.number(),
  created_at: z.string(),
  updated_at: z.string(),
});

type WebReceiptSource = z.infer<typeof WebReceiptSourceSchema>;

const UpdateSourceSchema = z.object({
  enabled: z.number().min(0).max(1).optional(),
  schedule_frequency: z.string().optional(),
  schedule_day_of_month: z.number().optional(),
  schedule_hour: z.number().optional(),
});

// ============================================================================
// Handlers
// ============================================================================

/**
 * GET /api/receipts/sources - List all sources
 */
async function handleListSources(env: Env): Promise<Response> {
  if (!env.DB) {
    return new Response(JSON.stringify({ error: 'Database not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const result = await env.DB.prepare(
      `SELECT
        id,
        name,
        description,
        enabled,
        url,
        schedule_frequency,
        schedule_day_of_month,
        schedule_hour,
        last_run_at,
        last_run_status,
        last_run_receipts_count,
        last_error,
        total_runs,
        total_receipts,
        created_at,
        updated_at
      FROM web_receipt_sources
      ORDER BY name ASC`
    ).all<WebReceiptSource>();

    return new Response(
      JSON.stringify({
        sources: result.results || [],
        total: result.results?.length || 0,
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({
        error: 'Failed to fetch sources',
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
 * GET /api/receipts/sources/:id - Get source details
 */
async function handleGetSource(env: Env, sourceId: string): Promise<Response> {
  if (!env.DB) {
    return new Response(JSON.stringify({ error: 'Database not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const source = await env.DB.prepare(
      `SELECT
        id,
        name,
        description,
        enabled,
        url,
        schedule_frequency,
        schedule_day_of_month,
        schedule_hour,
        last_run_at,
        last_run_status,
        last_run_receipts_count,
        last_error,
        total_runs,
        total_receipts,
        created_at,
        updated_at
      FROM web_receipt_sources
      WHERE id = ?`
    )
      .bind(sourceId)
      .first<WebReceiptSource>();

    if (!source) {
      return new Response(JSON.stringify({ error: 'Source not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Get recent logs
    const logs = await env.DB.prepare(
      `SELECT
        id,
        started_at,
        completed_at,
        status,
        receipts_count,
        error_message
      FROM web_receipt_source_logs
      WHERE source_id = ?
      ORDER BY started_at DESC
      LIMIT 10`
    )
      .bind(sourceId)
      .all();

    return new Response(
      JSON.stringify({
        source,
        recentLogs: logs.results || [],
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({
        error: 'Failed to fetch source',
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
 * PATCH /api/receipts/sources/:id - Update source settings
 */
async function handleUpdateSource(
  env: Env,
  sourceId: string,
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
    const updates = UpdateSourceSchema.parse(body);

    // Build UPDATE query
    const setClauses: string[] = [];
    const bindings: any[] = [];

    if (updates.enabled !== undefined) {
      setClauses.push('enabled = ?');
      bindings.push(updates.enabled);
    }
    if (updates.schedule_frequency) {
      setClauses.push('schedule_frequency = ?');
      bindings.push(updates.schedule_frequency);
    }
    if (updates.schedule_day_of_month !== undefined) {
      setClauses.push('schedule_day_of_month = ?');
      bindings.push(updates.schedule_day_of_month);
    }
    if (updates.schedule_hour !== undefined) {
      setClauses.push('schedule_hour = ?');
      bindings.push(updates.schedule_hour);
    }

    if (setClauses.length === 0) {
      return new Response(JSON.stringify({ error: 'No updates provided' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    bindings.push(sourceId);

    await env.DB.prepare(
      `UPDATE web_receipt_sources SET ${setClauses.join(', ')} WHERE id = ?`
    )
      .bind(...bindings)
      .run();

    return new Response(
      JSON.stringify({ success: true, sourceId }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({
        error: 'Failed to update source',
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
 * POST /api/receipts/sources/:id/trigger - Manually trigger scraping
 */
async function handleTriggerSource(env: Env, sourceId: string): Promise<Response> {
  if (!env.DB) {
    return new Response(JSON.stringify({ error: 'Database not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    // Verify source exists and is enabled
    const source = await env.DB.prepare(
      'SELECT id, name, enabled FROM web_receipt_sources WHERE id = ?'
    )
      .bind(sourceId)
      .first<{ id: string; name: string; enabled: number }>();

    if (!source) {
      return new Response(JSON.stringify({ error: 'Source not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (source.enabled !== 1) {
      return new Response(JSON.stringify({ error: 'Source is disabled' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Create execution log entry
    const logId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO web_receipt_source_logs (id, source_id, started_at, status)
       VALUES (?, ?, datetime('now'), 'running')`
    )
      .bind(logId, sourceId)
      .run();

    // Trigger GitHub Actions workflow
    const githubToken = env.GITHUB_TOKEN;
    const githubRepo = env.GITHUB_REPO || 'cursorvers/cloudflare-workers-hub';

    if (!githubToken) {
      // Fallback: Log the trigger request but don't fail
      await env.DB.prepare(
        `UPDATE web_receipt_source_logs
         SET completed_at = datetime('now'), status = 'failed',
             error_message = 'GITHUB_TOKEN not configured'
         WHERE id = ?`
      )
        .bind(logId)
        .run();

      return new Response(
        JSON.stringify({
          success: false,
          message: 'GitHub Actions trigger not configured. Manual workflow_dispatch required.',
          sourceId,
          logId,
        }),
        {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    // Call GitHub Actions API
    const workflowId = 'web-receipt-scraper.yml';
    const githubApiUrl = `https://api.github.com/repos/${githubRepo}/actions/workflows/${workflowId}/dispatches`;

    const githubResponse = await fetch(githubApiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${githubToken}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ref: 'main',
        inputs: {
          source: sourceId,
        },
      }),
    });

    if (!githubResponse.ok) {
      const errorText = await githubResponse.text();
      await env.DB.prepare(
        `UPDATE web_receipt_source_logs
         SET completed_at = datetime('now'), status = 'failed',
             error_message = ?
         WHERE id = ?`
      )
        .bind(`GitHub API error: ${githubResponse.status} ${errorText}`, logId)
        .run();

      return new Response(
        JSON.stringify({
          error: 'Failed to trigger GitHub Actions',
          details: `HTTP ${githubResponse.status}: ${errorText}`,
        }),
        {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    // Success: Workflow dispatched
    return new Response(
      JSON.stringify({
        success: true,
        message: 'Scraping triggered. Results will be available in a few minutes.',
        sourceId,
        logId,
        note: 'Check GitHub Actions for execution status',
      }),
      {
        status: 202, // Accepted
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({
        error: 'Failed to trigger scraping',
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

export async function handleReceiptSourcesAPI(
  request: Request,
  env: Env,
  path: string
): Promise<Response> {
  const url = new URL(request.url);
  const pathSegments = path.replace('/api/receipts/sources', '').split('/').filter(Boolean);

  // GET /api/receipts/sources
  if (request.method === 'GET' && pathSegments.length === 0) {
    return handleListSources(env);
  }

  // GET /api/receipts/sources/:id
  if (request.method === 'GET' && pathSegments.length === 1) {
    return handleGetSource(env, pathSegments[0]);
  }

  // PATCH /api/receipts/sources/:id
  if (request.method === 'PATCH' && pathSegments.length === 1) {
    return handleUpdateSource(env, pathSegments[0], request);
  }

  // POST /api/receipts/sources/:id/trigger
  if (request.method === 'POST' && pathSegments.length === 2 && pathSegments[1] === 'trigger') {
    return handleTriggerSource(env, pathSegments[0]);
  }

  return new Response(JSON.stringify({ error: 'Not found' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json' },
  });
}
