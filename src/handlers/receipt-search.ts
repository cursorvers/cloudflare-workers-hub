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

  // Get R2 signed URL (5-minute expiry for security)
  const r2Key = receipt.r2_object_key as string;
  const bucket = env.RECEIPTS ?? env.R2;
  if (!bucket) {
    return new Response('Receipt storage not configured', { status: 500 });
  }
  const signedUrl = await bucket.get(r2Key, {
    onlyIf: { etagMatches: receipt.file_hash as string },
  });

  return new Response(
    JSON.stringify({
      receipt,
      audit_trail: auditTrail.results || [],
      file_url: signedUrl?.httpMetadata ? signedUrl.httpMetadata : null,
    }),
    {
      headers: { 'Content-Type': 'application/json' },
    }
  );
}
