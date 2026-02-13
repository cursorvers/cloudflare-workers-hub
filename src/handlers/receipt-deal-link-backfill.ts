/**
 * Receipt↔Deal Link Backfill (Cron)
 *
 * Purpose:
 * - Remediate legacy cases where a freee Deal was created but the evidence receipt
 *   (File Box receipt) was not linked to the Deal (receipt_ids missing).
 *
 * Strategy:
 * - Scan receipt_deals for rows that have both deal_id and freee_receipt_id,
 *   but have not been link-verified yet.
 * - For each, call createDealFromReceipt() with retry_link_if_existing=true,
 *   which performs an idempotent link (GET deal -> PUT deal with receipt_ids merged).
 * - Record verification markers on success and retry counters on failure.
 *
 * Constraints:
 * - Keep this conservative to avoid hitting freee rate limits (300/h).
 */

import type { Env } from '../types';
import { safeLog } from '../utils/log-sanitizer';
import { isFreeeIntegrationEnabled } from '../utils/freee-integration';
import { createFreeeClient } from '../services/freee-client';
import { createDealFromReceipt, type ReceiptInput } from '../services/freee-deal-service';

const DEFAULT_LINK_BACKFILL_LIMIT = 5;
const MAX_RETRIES_PER_ROW = 5;

interface LinkBackfillRow {
  receipt_id: string;
  deal_id: number;
  freee_receipt_id: string;
  r2_object_key: string;
  file_hash: string | null;
  vendor_name: string;
  amount: number;
  currency: string;
  transaction_date: string;
  account_category: string | null;
  classification_confidence: number | null;
  tenant_id: string;
  link_retry_count: number;
}

function isDeletedReceiptError(message: string): boolean {
  return message.includes('証憑は既に削除されています') || message.toLowerCase().includes('receipt') && message.toLowerCase().includes('deleted');
}

async function tryReuploadReceiptEvidence(
  env: Env,
  row: LinkBackfillRow,
): Promise<string | null> {
  const bucket = env.RECEIPTS ?? env.R2 ?? null;
  if (!bucket) {
    return null;
  }

  if (!env.DB) {
    return null;
  }

  const r2Key = row.r2_object_key;
  if (!r2Key) {
    return null;
  }

  const obj = await bucket.get(r2Key);
  if (!obj) {
    return null;
  }

  const blob = await obj.blob();
  const fileName = r2Key.split('/').pop() || 'receipt.pdf';
  const idempotencyKey = `reupload:deleted:${row.tenant_id || 'default'}:${row.file_hash ?? row.receipt_id}`;

  const freeeClient = createFreeeClient(env);
  const upload = await freeeClient.uploadReceipt(blob, fileName, idempotencyKey);
  const newFreeeReceiptId = String(upload.receipt.id);

  // Keep receipts table in sync (receipt_deals will be updated by recordDealLink later).
  await env.DB.prepare(
    `UPDATE receipts
     SET freee_receipt_id = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).bind(newFreeeReceiptId, row.receipt_id).run();

  return newFreeeReceiptId;
}

export async function backfillReceiptDealLinks(
  env: Env,
  opts?: { limit?: number },
): Promise<{
  scanned: number;
  attempted: number;
  verified: number;
  failed: number;
  skipped: number;
}> {
  if (!env.DB) {
    safeLog.warn('[DealLinkBackfill] DB not configured, skipping');
    return { scanned: 0, attempted: 0, verified: 0, failed: 0, skipped: 0 };
  }

  if (!isFreeeIntegrationEnabled(env)) {
    safeLog.info('[DealLinkBackfill] freee integration disabled, skipping');
    return { scanned: 0, attempted: 0, verified: 0, failed: 0, skipped: 0 };
  }

  // If migration hasn't been applied yet, this query will fail. Fail closed (skip),
  // because blindly retrying could cause repeated errors every cron run.
  let results: LinkBackfillRow[] = [];
  const rawLimit = typeof opts?.limit === 'number' && Number.isFinite(opts.limit) ? Math.floor(opts.limit) : DEFAULT_LINK_BACKFILL_LIMIT;
  const limit = Math.min(10, Math.max(1, rawLimit)); // keep API usage conservative
  try {
    const q = await env.DB.prepare(
      `SELECT
         rd.receipt_id,
         rd.deal_id,
         rd.freee_receipt_id,
         r.r2_object_key,
         r.file_hash,
         r.vendor_name,
         r.amount,
         r.currency,
         r.transaction_date,
         r.account_category,
         r.classification_confidence,
         r.tenant_id,
         rd.link_retry_count
       FROM receipt_deals rd
       JOIN receipts r ON r.id = rd.receipt_id
       WHERE rd.deal_id IS NOT NULL
         AND rd.freee_receipt_id IS NOT NULL
         AND rd.freee_receipt_id != ''
         AND rd.link_verified_at IS NULL
         AND rd.link_retry_count < ?
       ORDER BY rd.created_at DESC
       LIMIT ?`
    ).bind(MAX_RETRIES_PER_ROW, limit).all<LinkBackfillRow>();
    results = q.results ?? [];
  } catch (error) {
    safeLog.warn('[DealLinkBackfill] Query failed (migration not applied yet?)', {
      error: error instanceof Error ? error.message : String(error),
    });
    return { scanned: 0, attempted: 0, verified: 0, failed: 0, skipped: 0 };
  }

  const scanned = results.length;
  if (scanned === 0) {
    return { scanned: 0, attempted: 0, verified: 0, failed: 0, skipped: 0 };
  }

  let attempted = 0;
  let verified = 0;
  let failed = 0;
  let skipped = 0;

  for (const row of results) {
    const receiptId = row.receipt_id;
    attempted += 1;

    // Mark attempt (best-effort, do not block link attempt).
    await env.DB.prepare(
      `UPDATE receipt_deals
       SET link_retry_count = link_retry_count + 1,
           link_last_attempt_at = datetime('now')
       WHERE receipt_id = ?`
    ).bind(receiptId).run().catch(() => {});

    const receiptInput: ReceiptInput = {
      id: receiptId,
      freee_receipt_id: row.freee_receipt_id,
      retry_link_if_existing: true,
      file_hash: row.file_hash,
      vendor_name: row.vendor_name,
      amount: row.amount,
      currency: row.currency,
      transaction_date: row.transaction_date,
      account_category: row.account_category ?? null,
      classification_confidence: row.classification_confidence,
      tenant_id: row.tenant_id,
    };

    try {
      await createDealFromReceipt(env, receiptInput);
      verified += 1;

      await env.DB.prepare(
        `UPDATE receipt_deals
         SET link_verified_at = datetime('now'),
             link_last_error = NULL
         WHERE receipt_id = ?`
      ).bind(receiptId).run();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      // If the evidence receipt was deleted in freee, re-upload from R2 and retry once.
      if (isDeletedReceiptError(message)) {
        try {
          const newFreeeReceiptId = await tryReuploadReceiptEvidence(env, row);
          if (newFreeeReceiptId) {
            const retryInput: ReceiptInput = { ...receiptInput, freee_receipt_id: newFreeeReceiptId };
            await createDealFromReceipt(env, retryInput);

            verified += 1;
            await env.DB.prepare(
              `UPDATE receipt_deals
               SET link_verified_at = datetime('now'),
                   link_last_error = NULL
               WHERE receipt_id = ?`
            ).bind(receiptId).run();
            continue;
          }
        } catch (retryError) {
          const retryMsg = retryError instanceof Error ? retryError.message : String(retryError);
          safeLog.warn('[DealLinkBackfill] Re-upload + retry failed', {
            receiptId,
            dealId: row.deal_id,
            error: retryMsg,
          });
        }
      }

      failed += 1;
      safeLog.warn('[DealLinkBackfill] Link attempt failed', {
        receiptId,
        dealId: row.deal_id,
        freeeReceiptId: row.freee_receipt_id,
        error: message,
      });

      await env.DB.prepare(
        `UPDATE receipt_deals
         SET link_last_error = ?
         WHERE receipt_id = ?`
      ).bind(message, receiptId).run().catch(() => {});
    }
  }

  // No special skip paths today, keep metric for future filters.
  return { scanned, attempted, verified, failed, skipped };
}
