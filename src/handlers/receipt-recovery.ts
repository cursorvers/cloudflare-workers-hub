/**
 * Receipt Recovery Jobs (Cron)
 *
 * Purpose:
 * - Recover PDF receipts that got stuck in needs_review due to transient Gmail poll failures
 *   (e.g., "Too many subrequests", missing token during rollout).
 * - Upload the PDF from R2 to freee File Box, then re-classify and (if possible) create/link deal.
 *
 * This runs in scheduled cron context, so it uses Worker secrets directly and does not require API keys.
 */

import type { Env } from '../types';
import { safeLog } from '../utils/log-sanitizer';
import { isFreeeIntegrationEnabled } from '../utils/freee-integration';
import { createFreeeClient } from '../services/freee-client';
import { classifyReceipt } from '../services/ai-receipt-classifier';
import type { ClassificationResult } from '../services/ai-receipt-classifier';
import { extractPdfText } from '../services/pdf-text-extractor';
import { createDealFromReceipt, type ReceiptInput } from '../services/freee-deal-service';

// Keep this conservative to avoid hitting freee rate limits in the hourly cron.
const MAX_RECOVERY_PER_RUN = 5;
const DEFAULT_TENANT_ID = 'default';

type RecoverableErrorCode = 'GMAIL_POLL_FAILED' | 'CLASSIFICATION_FAILED';

interface RecoverableReceiptRow {
  id: string;
  r2_object_key: string;
  file_hash: string;
  vendor_name: string;
  amount: number;
  currency: string;
  transaction_date: string;
  account_category: string | null;
  classification_confidence: number | null;
  tenant_id: string;
  error_code: RecoverableErrorCode;
}

function buildClassificationTextFromR2(
  row: RecoverableReceiptRow,
  metadata: Record<string, string>,
  extractedPdfText: string | null,
): string {
  const parts = [
    `Subject: ${metadata.subject || ''}`,
    `From: ${metadata.from || row.vendor_name}`,
    `Date: ${row.transaction_date}`,
    `Attachment: ${row.r2_object_key.split('/').pop() || 'receipt.pdf'}`,
  ];

  if (extractedPdfText && extractedPdfText.trim().length > 0) {
    parts.push('', 'PDF Text (extracted):', '---BEGIN PDF TEXT---', extractedPdfText.slice(0, 8000), '---END PDF TEXT---');
  }

  return parts.join('\n');
}

async function tryExtractPdfText(env: Env, pdfBytes: ArrayBuffer, ctx: Record<string, unknown>): Promise<string | null> {
  try {
    const res = await extractPdfText(pdfBytes, { maxBytes: 10 * 1024 * 1024, maxPages: 50 });
    const cleaned = res.text.replace(/\u0000/g, '').slice(0, 8000);
    return cleaned.trim().length > 0 ? cleaned : null;
  } catch (error) {
    safeLog.warn('[Recovery] PDF text extraction failed (continuing)', {
      ...ctx,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Cron job: recover PDF receipts stuck in needs_review due to Gmail poll failures.
 */
export async function recoverPdfReceiptsNeedingFreeeUpload(env: Env): Promise<{
  scanned: number;
  recovered: number;
  uploaded: number;
  dealsCreated: number;
  needsReview: number;
  failed: number;
}> {
  if (!env.DB) {
    safeLog.warn('[Recovery] DB not configured, skipping');
    return { scanned: 0, recovered: 0, uploaded: 0, dealsCreated: 0, needsReview: 0, failed: 0 };
  }

  const bucket = env.RECEIPTS ?? env.R2 ?? null;
  if (!bucket) {
    safeLog.warn('[Recovery] R2 bucket not configured, skipping');
    return { scanned: 0, recovered: 0, uploaded: 0, dealsCreated: 0, needsReview: 0, failed: 0 };
  }

  if (!isFreeeIntegrationEnabled(env)) {
    safeLog.info('[Recovery] freee integration disabled, skipping');
    return { scanned: 0, recovered: 0, uploaded: 0, dealsCreated: 0, needsReview: 0, failed: 0 };
  }

  const freeeClient = createFreeeClient(env);

  const { results } = await env.DB.prepare(
    `SELECT id, r2_object_key, file_hash, vendor_name, amount, currency, transaction_date,
            account_category, classification_confidence, tenant_id, error_code
     FROM receipts
     WHERE source_type = 'pdf_attachment'
       AND status = 'needs_review'
       AND freee_receipt_id IS NULL
       AND error_code IN ('GMAIL_POLL_FAILED', 'CLASSIFICATION_FAILED')
       AND r2_object_key LIKE '%.pdf'
     ORDER BY updated_at DESC
     LIMIT ?`
  ).bind(MAX_RECOVERY_PER_RUN).all<RecoverableReceiptRow>();

  const scanned = results?.length ?? 0;
  if (scanned === 0) {
    return { scanned: 0, recovered: 0, uploaded: 0, dealsCreated: 0, needsReview: 0, failed: 0 };
  }

  let uploaded = 0;
  let dealsCreated = 0;
  let needsReview = 0;
  let failed = 0;

  for (const row of results ?? []) {
    const receiptId = row.id;
    try {
      const obj = await bucket.get(row.r2_object_key);
      if (!obj) {
        needsReview += 1;
        await env.DB.prepare(
          `UPDATE receipts
           SET error_code = 'R2_OBJECT_MISSING',
               error_message = 'Recovery could not read receipt from R2',
               updated_at = datetime('now')
           WHERE id = ?`
        ).bind(receiptId).run();
        continue;
      }

      const metadata = obj.customMetadata || {};
      const pdfBytes = await obj.arrayBuffer();
      const extractedText = await tryExtractPdfText(env, pdfBytes, { receiptId, r2Key: row.r2_object_key });

      // 1) Upload to freee File Box (idempotent by file_hash)
      const blob = new Blob([pdfBytes], { type: 'application/pdf' });
      const fileName = row.r2_object_key.split('/').pop() || 'receipt.pdf';
      const idempotencyKey = `recovery:${row.file_hash}`;
      const freeeUpload = await freeeClient.uploadReceipt(blob, fileName, idempotencyKey);
      uploaded += 1;

      // Persist freee receipt id early (evidence is the primary invariant)
      await env.DB.prepare(
        `UPDATE receipts
         SET freee_receipt_id = ?, updated_at = datetime('now')
         WHERE id = ?`
      ).bind(String(freeeUpload.receipt.id), receiptId).run();

      // 2) Re-classify using extracted text (best effort)
      let classification: ClassificationResult;
      try {
        const classificationText = buildClassificationTextFromR2(
          row,
          metadata,
          extractedText,
        );
        classification = await classifyReceipt(env, classificationText, {
          tenantId: row.tenant_id || DEFAULT_TENANT_ID,
          source: 'recovery',
        });
      } catch (error) {
        needsReview += 1;
        const msg = error instanceof Error ? error.message : String(error);
        await env.DB.prepare(
          `UPDATE receipts
           SET status = 'needs_review',
               error_code = 'CLASSIFICATION_FAILED',
               error_message = ?,
               updated_at = datetime('now')
           WHERE id = ?`
        ).bind(msg, receiptId).run();
        continue;
      }

      const newVendor = classification.vendor_name || row.vendor_name;
      const newAmount = Number.isFinite(classification.amount) ? Math.round(classification.amount) : 0;
      const newCurrency = (classification.currency || row.currency || 'JPY').toUpperCase();
      const newCategory = classification.account_category ?? row.account_category ?? null;
      const newConfidence = classification.confidence ?? row.classification_confidence ?? 0;

      await env.DB.prepare(
        `UPDATE receipts
         SET vendor_name = ?, amount = ?, currency = ?, account_category = ?,
             classification_confidence = ?, classification_method = ?,
             updated_at = datetime('now')
         WHERE id = ?`
      ).bind(
        newVendor,
        newAmount > 0 ? newAmount : row.amount,
        newCurrency,
        newCategory,
        newConfidence,
        classification.method,
        receiptId,
      ).run();

      // 3) Deal creation if feasible (JPY + amount>0)
      if (newAmount <= 0) {
        needsReview += 1;
        await env.DB.prepare(
          `UPDATE receipts
           SET status = 'needs_review',
               error_code = 'AMOUNT_MISSING',
               error_message = 'Recovery could not extract a positive amount; deal not created',
               updated_at = datetime('now')
           WHERE id = ?`
        ).bind(receiptId).run();
        continue;
      }
      if (newCurrency !== 'JPY') {
        needsReview += 1;
        await env.DB.prepare(
          `UPDATE receipts
           SET status = 'needs_review',
               error_code = 'FOREIGN_CURRENCY',
               error_message = 'Recovery detected non-JPY currency; deal not created',
               updated_at = datetime('now')
           WHERE id = ?`
        ).bind(receiptId).run();
        continue;
      }

      const receiptInput: ReceiptInput = {
        id: receiptId,
        freee_receipt_id: freeeUpload.receipt.id,
        retry_link_if_existing: true,
        file_hash: row.file_hash,
        vendor_name: newVendor,
        amount: newAmount,
        currency: newCurrency,
        transaction_date: classification.transaction_date || row.transaction_date,
        account_category: classification.account_category ?? null,
        classification_confidence: newConfidence ?? null,
        tenant_id: row.tenant_id || DEFAULT_TENANT_ID,
      };

      const dealRes = await createDealFromReceipt(env, receiptInput);

      if (dealRes.dealId) {
        await env.DB.prepare(
          `UPDATE receipts
           SET freee_deal_id = ?, freee_partner_id = ?,
               account_item_id = ?, tax_code = ?,
               account_mapping_confidence = ?, account_mapping_method = ?,
               status = 'completed',
               error_code = NULL, error_message = NULL,
               completed_at = COALESCE(completed_at, datetime('now')),
               updated_at = datetime('now')
           WHERE id = ?`
        ).bind(
          dealRes.dealId,
          dealRes.partnerId,
          dealRes.accountItemId ?? null,
          dealRes.taxCode ?? null,
          dealRes.mappingConfidence,
          dealRes.mappingMethod ?? null,
          receiptId,
        ).run();
        dealsCreated += 1;
      } else {
        // Deal creation skipped/needs_review; keep receipt uploaded but mark needs_review.
        needsReview += 1;
        await env.DB.prepare(
          `UPDATE receipts
           SET status = 'needs_review',
               error_code = COALESCE(error_code, 'DEAL_FAILED'),
               error_message = COALESCE(error_message, 'Recovery could not create a deal'),
               updated_at = datetime('now')
           WHERE id = ?`
        ).bind(receiptId).run();
      }
    } catch (error) {
      failed += 1;
      const msg = error instanceof Error ? error.message : String(error);
      safeLog.error('[Recovery] Receipt recovery failed', { receiptId, error: msg });
      try {
        await env.DB.prepare(
          `UPDATE receipts
           SET status = 'needs_review',
               error_code = 'RECOVERY_FAILED',
               error_message = ?,
               updated_at = datetime('now')
           WHERE id = ?`
        ).bind(msg, receiptId).run();
      } catch {
        // best-effort
      }
    }
  }

  return {
    scanned,
    recovered: uploaded, // at minimum, evidence was uploaded
    uploaded,
    dealsCreated,
    needsReview,
    failed,
  };
}

