/**
 * Receipt Backfill Handler
 *
 * Re-classifies existing receipts with updated rules and creates deals.
 * Triggered via POST /api/receipts/backfill (admin only).
 *
 * Phase D of the sensitivity improvement plan (2026-02-09).
 */

import type { Env } from '../types';
import { safeLog } from '../utils/log-sanitizer';
import { classifyReceipt } from '../services/ai-receipt-classifier';
import { createDealFromReceipt, type ReceiptInput } from '../services/freee-deal-service';

// =============================================================================
// Types
// =============================================================================

interface BackfillReceipt {
  id: string;
  r2_object_key: string;
  file_hash: string;
  vendor_name: string;
  amount: number;
  transaction_date: string;
  account_category: string | null;
  classification_confidence: number;
  freee_receipt_id: string | null;
  source_type: string;
}

interface BackfillResult {
  id: string;
  vendor_name: string;
  status: 'reclassified' | 'deal_created' | 'skipped' | 'failed';
  newVendor?: string;
  newAmount?: number;
  newCategory?: string;
  newConfidence?: number;
  dealId?: number | null;
  dealStatus?: string;
  error?: string;
}

// =============================================================================
// Constants
// =============================================================================

const MAX_BACKFILL = 50;
const MAX_DEALS_PER_RUN = 8;
const DEFAULT_TENANT_ID = 'default';

// =============================================================================
// Handler
// =============================================================================

export async function handleReceiptBackfill(
  request: Request,
  env: Env
): Promise<Response> {
  const bucket = env.RECEIPTS ?? env.R2;
  if (!bucket) {
    return jsonResponse({ error: 'R2 bucket not configured' }, 500);
  }

  if (!env.DB) {
    return jsonResponse({ error: 'D1 database not configured' }, 500);
  }

  // Optional: filter by receipt IDs from request body
  let filterIds: string[] | null = null;
  try {
    const body = await request.json() as { ids?: string[] };
    if (body.ids && Array.isArray(body.ids)) {
      filterIds = body.ids;
    }
  } catch {
    // No body or invalid JSON — process all
  }

  // Query receipts needing backfill: no deal, has freee_receipt_id
  const query = filterIds
    ? `SELECT id, r2_object_key, file_hash, vendor_name, amount, transaction_date,
              account_category, classification_confidence, freee_receipt_id, source_type
       FROM receipts
       WHERE freee_deal_id IS NULL AND freee_receipt_id IS NOT NULL
         AND id IN (${filterIds.map(() => '?').join(',')})
       ORDER BY created_at DESC LIMIT ?`
    : `SELECT id, r2_object_key, file_hash, vendor_name, amount, transaction_date,
              account_category, classification_confidence, freee_receipt_id, source_type
       FROM receipts
       WHERE freee_deal_id IS NULL AND freee_receipt_id IS NOT NULL
       ORDER BY created_at DESC LIMIT ?`;

  const bindings = filterIds
    ? [...filterIds, MAX_BACKFILL]
    : [MAX_BACKFILL];

  const { results: receipts } = await env.DB.prepare(query)
    .bind(...bindings)
    .all<BackfillReceipt>();

  if (!receipts || receipts.length === 0) {
    return jsonResponse({ success: true, message: 'No receipts to backfill', count: 0 });
  }

  safeLog.info('[Backfill] Starting', { count: receipts.length });

  const results: BackfillResult[] = [];
  let dealsCreated = 0;

  for (const receipt of receipts) {
    try {
      // Step 1: Read PDF from R2 and re-classify
      const obj = await bucket.get(receipt.r2_object_key);
      if (!obj) {
        results.push({
          id: receipt.id,
          vendor_name: receipt.vendor_name,
          status: 'skipped',
          error: 'R2 object not found',
        });
        continue;
      }

      // Build classification text from R2 object metadata + content
      const metadata = obj.customMetadata || {};
      const textParts = [
        `Subject: ${metadata.subject || ''}`,
        `From: ${metadata.from || receipt.vendor_name}`,
        `Date: ${receipt.transaction_date}`,
        `Attachment: ${receipt.r2_object_key.split('/').pop() || 'receipt.pdf'}`,
      ];

      // Try to extract text from PDF for better classification
      // (R2 stored the raw PDF, not extracted text)
      const blob = await obj.arrayBuffer();
      const blobText = new TextDecoder('utf-8', { fatal: false }).decode(blob);

      // If the content looks like text (not binary PDF), use it
      const hasReadableText = blobText.includes('Invoice') ||
        blobText.includes('Receipt') ||
        blobText.includes('合計') ||
        blobText.includes('請求') ||
        blobText.includes('領収') ||
        blobText.includes('Amount') ||
        blobText.includes('Total');

      if (hasReadableText) {
        // Truncate to prevent oversize classification input
        const truncated = blobText.slice(0, 8000);
        textParts.push('', 'PDF Text (extracted):', '---BEGIN PDF TEXT---', truncated, '---END PDF TEXT---');
      }

      const classificationText = textParts.join('\n');

      // Step 2: Re-classify with updated rules
      const classification = await classifyReceipt(env, classificationText, {
        vendor_name: receipt.vendor_name,
        amount: receipt.amount,
        transaction_date: receipt.transaction_date,
      });

      // Step 3: Update D1 with new classification
      const newVendor = classification.vendor_name || receipt.vendor_name;
      const newAmount = classification.amount > 0 ? Math.round(classification.amount) : receipt.amount;
      const newCategory = classification.account_category || receipt.account_category;
      const newConfidence = classification.confidence;

      await env.DB.prepare(
        `UPDATE receipts
         SET vendor_name = ?, amount = ?, account_category = ?,
             classification_confidence = ?, classification_method = ?,
             updated_at = datetime('now')
         WHERE id = ?`
      ).bind(
        newVendor,
        newAmount,
        newCategory,
        newConfidence,
        classification.method,
        receipt.id
      ).run();

      const result: BackfillResult = {
        id: receipt.id,
        vendor_name: receipt.vendor_name,
        status: 'reclassified',
        newVendor,
        newAmount,
        newCategory,
        newConfidence,
      };

      // Step 4: Create deal if we have a freee_receipt_id and haven't hit the limit
      if (receipt.freee_receipt_id && dealsCreated < MAX_DEALS_PER_RUN) {
        try {
          const receiptInput: ReceiptInput = {
            id: receipt.id,
            freee_receipt_id: receipt.freee_receipt_id,
            file_hash: receipt.file_hash,
            vendor_name: newVendor,
            amount: newAmount,
            transaction_date: receipt.transaction_date,
            account_category: newCategory,
            classification_confidence: newConfidence,
            tenant_id: DEFAULT_TENANT_ID,
          };

          const dealResult = await createDealFromReceipt(env, receiptInput);

          // Update D1 with deal info
          await env.DB.prepare(
            `UPDATE receipts
             SET freee_deal_id = ?, freee_partner_id = ?,
                 account_item_id = ?, tax_code = ?,
                 account_mapping_confidence = ?,
                 account_mapping_method = ?,
                 updated_at = datetime('now')
             WHERE id = ?`
          ).bind(
            dealResult.dealId,
            dealResult.partnerId,
            dealResult.accountItemId ?? null,
            dealResult.taxCode ?? null,
            dealResult.mappingConfidence,
            dealResult.mappingMethod ?? null,
            receipt.id
          ).run();

          result.status = 'deal_created';
          result.dealId = dealResult.dealId;
          result.dealStatus = dealResult.status;

          if (dealResult.dealId) {
            dealsCreated += 1;
          }
        } catch (dealError) {
          // Deal creation failed, but reclassification succeeded
          result.error = `Deal failed: ${dealError instanceof Error ? dealError.message : String(dealError)}`;
        }
      }

      results.push(result);
    } catch (error) {
      results.push({
        id: receipt.id,
        vendor_name: receipt.vendor_name,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const summary = {
    total: results.length,
    reclassified: results.filter(r => r.status === 'reclassified').length,
    dealsCreated: results.filter(r => r.status === 'deal_created').length,
    skipped: results.filter(r => r.status === 'skipped').length,
    failed: results.filter(r => r.status === 'failed').length,
  };

  safeLog.info('[Backfill] Completed', summary);

  return jsonResponse({ success: true, summary, results });
}

// =============================================================================
// Helpers
// =============================================================================

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// =============================================================================
// Cron-triggered backfill (one-time, env-flag gated)
// =============================================================================

/**
 * Cron-callable backfill: processes all receipts without deals.
 * Gated by RECEIPT_BACKFILL_ENABLED env var.
 * After running, set RECEIPT_BACKFILL_ENABLED to 'false' to disable.
 */
export async function handleReceiptBackfillCron(env: Env): Promise<void> {
  const bucket = env.RECEIPTS ?? env.R2;
  if (!bucket || !env.DB) {
    safeLog.warn('[Backfill] R2 or D1 not configured, skipping');
    return;
  }

  const { results: receipts } = await env.DB.prepare(
    `SELECT id, r2_object_key, file_hash, vendor_name, amount, transaction_date,
            account_category, classification_confidence, freee_receipt_id, source_type
     FROM receipts
     WHERE freee_deal_id IS NULL AND freee_receipt_id IS NOT NULL
     ORDER BY created_at DESC LIMIT ?`
  ).bind(MAX_BACKFILL).all<BackfillReceipt>();

  if (!receipts || receipts.length === 0) {
    safeLog.info('[Backfill] No receipts to backfill');
    return;
  }

  safeLog.info('[Backfill] Starting cron backfill', { count: receipts.length });
  let reclassified = 0;
  let dealsCreated = 0;
  let failed = 0;

  for (const receipt of receipts) {
    try {
      const obj = await bucket.get(receipt.r2_object_key);
      if (!obj) { continue; }

      const metadata = obj.customMetadata || {};
      const textParts = [
        `Subject: ${metadata.subject || ''}`,
        `From: ${metadata.from || receipt.vendor_name}`,
        `Date: ${receipt.transaction_date}`,
        `Attachment: ${receipt.r2_object_key.split('/').pop() || 'receipt.pdf'}`,
      ];

      const blob = await obj.arrayBuffer();
      const blobText = new TextDecoder('utf-8', { fatal: false }).decode(blob);
      const hasReadableText = blobText.includes('Invoice') || blobText.includes('Receipt') ||
        blobText.includes('合計') || blobText.includes('請求') || blobText.includes('領収') ||
        blobText.includes('Amount') || blobText.includes('Total');

      if (hasReadableText) {
        const truncated = blobText.slice(0, 8000);
        textParts.push('', 'PDF Text (extracted):', '---BEGIN PDF TEXT---', truncated, '---END PDF TEXT---');
      }

      const classification = await classifyReceipt(env, textParts.join('\n'), {
        vendor_name: receipt.vendor_name,
        amount: receipt.amount,
        transaction_date: receipt.transaction_date,
      });

      const newVendor = classification.vendor_name || receipt.vendor_name;
      const newAmount = classification.amount > 0 ? Math.round(classification.amount) : receipt.amount;
      const newCategory = classification.account_category || receipt.account_category;

      await env.DB.prepare(
        `UPDATE receipts SET vendor_name = ?, amount = ?, account_category = ?,
           classification_confidence = ?, classification_method = ?, updated_at = datetime('now')
         WHERE id = ?`
      ).bind(newVendor, newAmount, newCategory, classification.confidence, classification.method, receipt.id).run();
      reclassified += 1;

      if (receipt.freee_receipt_id && dealsCreated < MAX_DEALS_PER_RUN) {
        try {
          const dealResult = await createDealFromReceipt(env, {
            id: receipt.id,
            freee_receipt_id: receipt.freee_receipt_id,
            file_hash: receipt.file_hash,
            vendor_name: newVendor,
            amount: newAmount,
            transaction_date: receipt.transaction_date,
            account_category: newCategory,
            classification_confidence: classification.confidence,
            tenant_id: DEFAULT_TENANT_ID,
          });

          await env.DB.prepare(
            `UPDATE receipts SET freee_deal_id = ?, freee_partner_id = ?,
               account_item_id = ?, tax_code = ?, account_mapping_confidence = ?,
               account_mapping_method = ?, updated_at = datetime('now') WHERE id = ?`
          ).bind(
            dealResult.dealId, dealResult.partnerId,
            dealResult.accountItemId ?? null, dealResult.taxCode ?? null,
            dealResult.mappingConfidence, dealResult.mappingMethod ?? null, receipt.id
          ).run();

          if (dealResult.dealId) { dealsCreated += 1; }
        } catch (dealError) {
          safeLog.warn('[Backfill] Deal creation failed', {
            receiptId: receipt.id,
            error: dealError instanceof Error ? dealError.message : String(dealError),
          });
        }
      }
    } catch (error) {
      failed += 1;
      safeLog.error('[Backfill] Receipt failed', {
        receiptId: receipt.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  safeLog.info('[Backfill] Cron backfill completed', { reclassified, dealsCreated, failed });
}
