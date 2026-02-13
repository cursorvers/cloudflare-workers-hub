/**
 * Receipt Search API
 *
 * Electronic Bookkeeping Law compliant search functionality
 * - Date range search
 * - Vendor name search
 * - Amount range search
 * - Combined search (date + vendor + amount)
 * - Instant display (< 3 seconds)
 */

import type { Env } from '../types';
import { z } from 'zod';
import { safeLog } from '../utils/log-sanitizer';

// =============================================================================
// Request Schema
// =============================================================================

const SearchQuerySchema = z.object({
  date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  vendor_name: z.string().optional(),
  amount_min: z.coerce.number().int().optional(),
  amount_max: z.coerce.number().int().optional(),
  document_type: z
    .enum(['invoice', 'receipt', 'expense_report', 'other'])
    .optional(),
  status: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

type SearchQuery = z.infer<typeof SearchQuerySchema>;

// =============================================================================
// Search Handler
// =============================================================================

export async function handleReceiptSearch(
  request: Request,
  env: Env
): Promise<Response> {
  const startTime = Date.now();
  if (!env.DB) {
    return new Response(JSON.stringify({ error: 'DB not configured' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Parse query parameters
  const url = new URL(request.url);
  const queryParams: Record<string, any> = {};
  url.searchParams.forEach((value, key) => {
    queryParams[key] = value;
  });

  // Validate query
  let query: SearchQuery;
  try {
    query = SearchQuerySchema.parse(queryParams);
  } catch (error) {
    return new Response(
      JSON.stringify({
        error: 'Invalid query parameters',
        details: error instanceof z.ZodError ? error.errors : error,
      }),
      {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  // Build SQL query
  const whereClauses: string[] = ['1=1'];
  const params: any[] = [];

  if (query.date_from) {
    whereClauses.push('transaction_date >= ?');
    params.push(query.date_from);
  }

  if (query.date_to) {
    whereClauses.push('transaction_date <= ?');
    params.push(query.date_to);
  }

  if (query.vendor_name) {
    whereClauses.push('vendor_name LIKE ?');
    params.push(`%${query.vendor_name}%`);
  }

  if (query.amount_min !== undefined) {
    whereClauses.push('amount >= ?');
    params.push(query.amount_min);
  }

  if (query.amount_max !== undefined) {
    whereClauses.push('amount <= ?');
    params.push(query.amount_max);
  }

  if (query.document_type) {
    whereClauses.push('document_type = ?');
    params.push(query.document_type);
  }

  if (query.status) {
    whereClauses.push('status = ?');
    params.push(query.status);
  }

  // Execute query
  const sql = `
    SELECT
      id,
      file_hash,
      r2_object_key,
      freee_receipt_id,
      transaction_date,
      vendor_name,
      amount,
      currency,
      document_type,
      account_category,
      tax_type,
      department,
      project,
      classification_method,
      classification_confidence,
      status,
      created_at,
      updated_at,
      completed_at
    FROM receipts
    WHERE ${whereClauses.join(' AND ')}
    ORDER BY transaction_date DESC, created_at DESC
    LIMIT ? OFFSET ?
  `;

  params.push(query.limit, query.offset);

  const results = await env.DB.prepare(sql).bind(...params).all();

  // Get total count
  const countSql = `
    SELECT COUNT(*) as total
    FROM receipts
    WHERE ${whereClauses.join(' AND ')}
  `;

  const countResult = await env.DB.prepare(countSql)
    .bind(...params.slice(0, -2)) // Exclude LIMIT and OFFSET
    .first<{ total: number }>();

  const total = countResult?.total || 0;

  const elapsed = Date.now() - startTime;

  safeLog(env, 'info', 'Receipt search executed', {
    total,
    returned: results.results?.length || 0,
    elapsed,
    query,
  });

  return new Response(
    JSON.stringify({
      results: results.results || [],
      total,
      limit: query.limit,
      offset: query.offset,
      elapsed,
    }),
    {
      headers: {
        'Content-Type': 'application/json',
        'X-Response-Time': `${elapsed}ms`,
      },
    }
  );
}

// =============================================================================
// Export Handler
// =============================================================================

/**
 * Export receipts as CSV for audit
 */
export async function handleReceiptExport(
  request: Request,
  env: Env
): Promise<Response> {
  // Use same search logic
  const searchResponse = await handleReceiptSearch(request, env);
  const searchData = (await searchResponse.json()) as any;

  if (!searchData.results) {
    return new Response('No results found', { status: 404 });
  }

  // Convert to CSV
  const headers = [
    'ID',
    'Transaction Date',
    'Vendor Name',
    'Amount',
    'Currency',
    'Document Type',
    'Account Category',
    'Tax Type',
    'Status',
    'freee Receipt ID',
    'Created At',
    'Completed At',
  ];

  const rows = searchData.results.map((r: any) => [
    r.id,
    r.transaction_date,
    r.vendor_name,
    r.amount,
    r.currency,
    r.document_type,
    r.account_category || '',
    r.tax_type || '',
    r.status,
    r.freee_receipt_id || '',
    r.created_at,
    r.completed_at || '',
  ]);

  const csv = [headers, ...rows].map((row) => row.join(',')).join('\n');

  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv',
      'Content-Disposition': `attachment; filename="receipts-${new Date().toISOString()}.csv"`,
    },
  });
}

// =============================================================================
// Get Receipt Detail
// =============================================================================

/**
 * Get full receipt details with audit trail
 */
export async function handleReceiptDetail(
  request: Request,
  env: Env,
  receiptId: string
): Promise<Response> {
  if (!env.DB) {
    return new Response(JSON.stringify({ error: 'DB not configured' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  // Get receipt
  const receipt = await env.DB.prepare(
    'SELECT * FROM receipts WHERE id = ?'
  )
    .bind(receiptId)
    .first();

  if (!receipt) {
    return new Response('Receipt not found', { status: 404 });
  }

  // Get audit trail
  const auditTrail = await env.DB.prepare(
    'SELECT * FROM audit_logs WHERE receipt_id = ? ORDER BY created_at ASC'
  )
    .bind(receiptId)
    .all();

  // Receipt evidence (R2 object) availability.
  // Note: R2 ETag is not guaranteed to match our SHA-256 file_hash, so do not use etagMatches here.
  const r2Key = receipt.r2_object_key as string;
  const bucket = env.RECEIPTS ?? env.R2;
  if (!bucket) {
    return new Response('Receipt storage not configured', { status: 500 });
  }
  const head = await bucket.head(r2Key);
  const has_file = Boolean(head);
  const file_url = has_file
    ? new URL(`/api/receipts/${receiptId}/file`, request.url).toString()
    : null;

  return new Response(
    JSON.stringify({
      receipt,
      audit_trail: auditTrail.results || [],
      has_file,
      file_url,
    }),
    {
      headers: { 'Content-Type': 'application/json' },
    }
  );
}


/**
 * Download receipt evidence file from R2.
 * Uses an authenticated API route, instead of relying on R2 signed URLs.
 */
export async function handleReceiptFileDownload(
  request: Request,
  env: Env,
  receiptId: string
): Promise<Response> {
  if (!env.DB) {
    return new Response(JSON.stringify({ error: 'DB not configured' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const receipt = (await env.DB.prepare(
    'SELECT id, r2_object_key FROM receipts WHERE id = ?'
  )
    .bind(receiptId)
    .first()) as { id?: string; r2_object_key?: string } | null;

  if (!receipt?.r2_object_key) {
    return new Response('Receipt not found', { status: 404 });
  }

  const bucket = env.RECEIPTS ?? env.R2;
  if (!bucket) {
    return new Response('Receipt storage not configured', { status: 500 });
  }

  if (request.method === 'HEAD') {
    const head = await bucket.head(receipt.r2_object_key);
    if (!head) {
      return new Response('Receipt file not found', { status: 404 });
    }

    const fileName = String(receipt.r2_object_key).split('/').pop() || 'receipt.bin';
    const headers = new Headers();
    // head() returns metadata only; write headers when available.
    (head as any).writeHttpMetadata?.(headers);
    headers.set('Content-Disposition', `attachment; filename="${fileName.replace(/"/g, '')}"`);
    headers.set('Cache-Control', 'private, max-age=300');
    if (typeof (head as any).size === 'number') {
      headers.set('Content-Length', String((head as any).size));
    }

    return new Response(null, { headers });
  }

  const obj = await bucket.get(receipt.r2_object_key);
  if (!obj) {
    return new Response('Receipt file not found', { status: 404 });
  }

  // Best-effort filename from key tail.
  const fileName = String(receipt.r2_object_key).split('/').pop() || 'receipt.bin';
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('Content-Disposition', `attachment; filename="${fileName.replace(/"/g, '')}"`);
  headers.set('Cache-Control', 'private, max-age=300');

  return new Response(obj.body, { headers });
}
