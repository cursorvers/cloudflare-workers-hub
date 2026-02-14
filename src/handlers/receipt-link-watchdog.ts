import type { Env } from '../types';
import { safeLog } from '../utils/log-sanitizer';
import { createFreeeClient, ApiError } from '../services/freee-client';

export interface ReceiptLinkWatchdogResult {
  readonly scanned: number;
  readonly ok: number;
  readonly attempted: number;
  readonly errors: number;
}

/**
 * Best-effort repair: ensure freee receipts are attached to their deals.
 *
 * This is intentionally conservative:
 * - Only operates on receipts that already have both `freee_receipt_id` and `freee_deal_id`.
 * - Idempotent (no-op if already attached).
 */
export async function runReceiptLinkWatchdog(
  env: Env,
  options?: { limit?: number; days?: number }
): Promise<ReceiptLinkWatchdogResult> {
  if (!env.DB) {
    return { scanned: 0, ok: 0, attempted: 0, errors: 0 };
  }

  const limit = Math.max(1, Math.min(50, options?.limit ?? 12));
  const days = Math.max(1, Math.min(30, options?.days ?? 7));

  const rows = await env.DB.prepare(
    `SELECT id, freee_receipt_id, freee_deal_id
     FROM receipts
     WHERE freee_receipt_id IS NOT NULL
       AND freee_receipt_id != ''
       AND freee_deal_id IS NOT NULL
       AND status IN ('completed', 'needs_review')
       AND created_at >= datetime('now', ?)
     ORDER BY created_at DESC
     LIMIT ?`
  )
    .bind(`-${days} days`, limit)
    .all<{ id: string; freee_receipt_id: string; freee_deal_id: number }>();

  const freeeClient = createFreeeClient(env);

  let scanned = 0;
  let ok = 0;
  let attempted = 0;
  let errors = 0;

  for (const r of rows.results ?? []) {
    scanned += 1;
    const receiptId = Number.parseInt(String(r.freee_receipt_id), 10);
    const dealId = Number.parseInt(String(r.freee_deal_id), 10);
    if (!Number.isFinite(receiptId) || receiptId <= 0 || !Number.isFinite(dealId) || dealId <= 0) {
      continue;
    }

    try {
      attempted += 1;
      await freeeClient.linkReceiptToDeal(receiptId, dealId);
      ok += 1;
    } catch (error) {
      errors += 1;
      const msg = error instanceof Error ? error.message : String(error);
      safeLog.warn('[ReceiptLinkWatchdog] Failed to ensure receipt is linked to deal', {
        receiptRowId: r.id,
        freeeReceiptId: receiptId,
        freeeDealId: dealId,
        error: msg,
        status: error instanceof ApiError ? error.status : undefined,
      });
    }
  }

  return { scanned, ok, attempted, errors };
}
