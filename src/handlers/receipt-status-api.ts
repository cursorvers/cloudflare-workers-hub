/**
 * Receipt Status API
 *
 * Provides filtered list and summary of receipts with freee integration status.
 * Uses existing receipts + receipt_deals tables (no new tables needed).
 *
 * Endpoints:
 *   GET /api/receipts?status=&from=&to=&limit=   — filtered list
 *   GET /api/receipts/summary                     — aggregate counts
 *
 * Status Decision Table (exclusive, priority order):
 *   1. extraction_failed: amount IS NULL OR amount <= 0
 *   2. needs_review:      freee_deal_id set, latest deal status = 'needs_review'
 *   3. imported:           freee_deal_id set
 *   4. pending:            freee_receipt_id set, no deal yet
 *   5. unprocessed:        not yet uploaded to freee
 */

import type { Env } from '../types';
import {
  tenantScopedQuery,
  type ResolvedTenantContext,
} from '../utils/tenant-isolation';

// =============================================================================
// Types
// =============================================================================

const VALID_STATUSES = [
  'imported',
  'pending',
  'needs_review',
  'extraction_failed',
  'unprocessed',
] as const;

type ReceiptStatus = (typeof VALID_STATUSES)[number];

interface ReceiptStatusRow {
  id: string;
  vendor_name: string;
  amount: number | null;
  transaction_date: string;
  source_type: string | null;
  freee_deal_id: number | null;
  freee_receipt_id: string | null;
  classification_confidence: number | null;
  account_category: string | null;
  created_at: string;
  deal_id: number | null;
  deal_status: string | null;
  mapping_confidence: number | null;
  receipt_status: ReceiptStatus;
}

interface SummaryRow {
  receipt_status: ReceiptStatus;
  count: number;
  total_amount: number;
}

// =============================================================================
// SQL fragments
// =============================================================================

/** CTE that computes receipt_status for every receipt (latest deal row only). */
const STATUS_CTE = `
WITH computed AS (
  SELECT
    r.id, r.vendor_name, r.amount, r.transaction_date, r.source_type,
    r.freee_deal_id, r.freee_receipt_id, r.classification_confidence,
    r.account_category, r.created_at,
    rd.deal_id, rd.status AS deal_status, rd.mapping_confidence,
    CASE
      WHEN r.amount IS NULL OR r.amount <= 0 THEN 'extraction_failed'
      WHEN r.freee_deal_id IS NOT NULL AND rd.status = 'needs_review' THEN 'needs_review'
      WHEN r.freee_deal_id IS NOT NULL THEN 'imported'
      WHEN r.freee_receipt_id IS NOT NULL THEN 'pending'
      ELSE 'unprocessed'
    END AS receipt_status
  FROM receipts r
  LEFT JOIN (
    SELECT * FROM receipt_deals
    WHERE rowid IN (SELECT MAX(rowid) FROM receipt_deals GROUP BY receipt_id)
  ) rd ON r.id = rd.receipt_id
)`;

// =============================================================================
// Validation helpers
// =============================================================================

function isValidStatus(value: string): value is ReceiptStatus {
  return (VALID_STATUSES as readonly string[]).includes(value);
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidDate(value: string): boolean {
  return ISO_DATE_RE.test(value) && !Number.isNaN(Date.parse(value));
}

function clampLimit(raw: string | null): number {
  const n = raw ? Number.parseInt(raw, 10) : 50;
  if (!Number.isFinite(n) || n < 1) return 1;
  if (n > 100) return 100;
  return n;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorResponse(message: string, status = 400): Response {
  return jsonResponse({ error: message }, status);
}

// =============================================================================
// GET /api/receipts — filtered list
// =============================================================================

export async function handleReceiptList(
  request: Request,
  env: Env,
  tenantContext: ResolvedTenantContext
): Promise<Response> {
  if (!env.DB) {
    return errorResponse('D1 database not configured', 500);
  }

  const url = new URL(request.url);
  const statusFilter = url.searchParams.get('status');
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  const limit = clampLimit(url.searchParams.get('limit'));

  // Validate
  if (statusFilter && !isValidStatus(statusFilter)) {
    return errorResponse(`Invalid status. Valid: ${VALID_STATUSES.join(', ')}`);
  }
  if (from && !isValidDate(from)) {
    return errorResponse('Invalid from date. Use YYYY-MM-DD.');
  }
  if (to && !isValidDate(to)) {
    return errorResponse('Invalid to date. Use YYYY-MM-DD.');
  }

  const conditions: string[] = ['tenant_id = ?'];
  const bindings: (string | number)[] = [tenantContext.tenantId];

  if (statusFilter) {
    conditions.push('receipt_status = ?');
    bindings.push(statusFilter);
  }
  if (from) {
    conditions.push('created_at >= ?');
    bindings.push(from);
  }
  if (to) {
    // Exclusive upper bound (< not <=)
    conditions.push('created_at < ?');
    bindings.push(to);
  }

  const whereClause = conditions.length > 0
    ? `WHERE ${conditions.join(' AND ')}`
    : '';

  const sql = `${STATUS_CTE}
SELECT * FROM computed
${whereClause}
ORDER BY created_at DESC
LIMIT ?`;

  bindings.push(limit);

  const { results } = await tenantScopedQuery<ReceiptStatusRow>(
    env,
    tenantContext.tenantId,
    sql,
    bindings
  );

  return jsonResponse({
    success: true,
    count: results?.length ?? 0,
    receipts: results ?? [],
  });
}

// =============================================================================
// GET /api/receipts/summary — aggregate counts
// =============================================================================

export async function handleReceiptSummary(
  _request: Request,
  env: Env,
  tenantContext: ResolvedTenantContext
): Promise<Response> {
  if (!env.DB) {
    return errorResponse('D1 database not configured', 500);
  }

const sql = `${STATUS_CTE}
SELECT
  receipt_status,
  COUNT(*) AS count,
  COALESCE(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END), 0) AS total_amount
FROM computed
WHERE tenant_id = ?
GROUP BY receipt_status`;

  const { results } = await tenantScopedQuery<SummaryRow>(
    env,
    tenantContext.tenantId,
    sql,
    [tenantContext.tenantId]
  );

  // Build summary object with all statuses (default 0)
  const summary: Record<string, { count: number; totalAmount: number }> = {};
  for (const status of VALID_STATUSES) {
    summary[status] = { count: 0, totalAmount: 0 };
  }

  let total = 0;
  let totalAmount = 0;

  for (const row of results ?? []) {
    if (row.receipt_status in summary) {
      summary[row.receipt_status] = {
        count: row.count,
        totalAmount: row.total_amount,
      };
    }
    total += row.count;
    totalAmount += row.total_amount;
  }

  return jsonResponse({
    success: true,
    total,
    totalAmount,
    byStatus: summary,
  });
}
