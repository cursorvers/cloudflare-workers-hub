/**
 * Receipt Backfill Handler
 *
 * Re-classifies existing receipts with updated rules and creates deals.
 * Triggered via POST /api/receipts/backfill (admin only) or hourly cron.
 *
 * Phase D of the sensitivity improvement plan (2026-02-09).
 *
 * IMPORTANT: R2 objects may not exist (known issue 2026-02-10).
 * When R2 is unavailable, falls back to D1 metadata for classification.
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
  status: 'reclassified' | 'deal_created' | 'deal_needs_review' | 'skipped' | 'failed';
  r2Available: boolean;
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
// Classification helpers
// =============================================================================

/**
 * Build classification text from R2 object (best quality).
 */
function buildClassificationTextFromR2(
  receipt: BackfillReceipt,
  metadata: Record<string, string>,
  blobText: string | null
): string {
  const parts = [
    `Subject: ${metadata.subject || ''}`,
    `From: ${metadata.from || receipt.vendor_name}`,
    `Date: ${receipt.transaction_date}`,
    `Attachment: ${receipt.r2_object_key.split('/').pop() || 'receipt.pdf'}`,
  ];

  if (blobText) {
    const hasReadableText = blobText.includes('Invoice') ||
      blobText.includes('Receipt') ||
      blobText.includes('合計') ||
      blobText.includes('請求') ||
      blobText.includes('領収') ||
      blobText.includes('Amount') ||
      blobText.includes('Total');

    if (hasReadableText) {
      const truncated = blobText.slice(0, 8000);
      parts.push('', 'PDF Text (extracted):', '---BEGIN PDF TEXT---', truncated, '---END PDF TEXT---');
    }
  }

  return parts.join('\n');
}

/**
 * Build classification text from D1 metadata only (fallback).
 * When R2 objects are missing, we still have vendor_name, amount,
 * transaction_date, and account_category from D1.
 */
function buildClassificationTextFromD1(receipt: BackfillReceipt): string {
  const parts = [
    `From: ${receipt.vendor_name}`,
    `Date: ${receipt.transaction_date}`,
    `Amount: ${receipt.amount} JPY`,
    `Source: ${receipt.source_type || 'unknown'}`,
  ];

  if (receipt.account_category) {
    parts.push(`Previous Category: ${receipt.account_category}`);
  }

  // Provide filename hint from R2 key (even if object doesn't exist)
  const fileName = receipt.r2_object_key.split('/').pop() || 'receipt.pdf';
  parts.push(`Attachment: ${fileName}`);

  return parts.join('\n');
}

// =============================================================================
// Core backfill logic (shared between API and cron)
// =============================================================================

async function backfillReceipt(
  env: Env,
  bucket: R2Bucket | null,
  receipt: BackfillReceipt,
  dealsCreated: number,
  maxDeals: number
): Promise<{ result: BackfillResult; newDealsCreated: number }> {
  let r2Available = false;
  let classificationText: string;

  // Step 1: Try R2, fall back to D1 metadata
  if (bucket) {
    try {
      const obj = await bucket.get(receipt.r2_object_key);
      if (obj) {
        r2Available = true;
        const metadata = obj.customMetadata || {};
        const blob = await obj.arrayBuffer();
        const blobText = new TextDecoder('utf-8', { fatal: false }).decode(blob);
        classificationText = buildClassificationTextFromR2(receipt, metadata, blobText);
      } else {
        // R2 object missing — use D1 metadata
        classificationText = buildClassificationTextFromD1(receipt);
      }
    } catch (r2Error) {
      safeLog.warn('[Backfill] R2 read failed, falling back to D1 metadata', {
        receiptId: receipt.id,
        error: r2Error instanceof Error ? r2Error.message : String(r2Error),
      });
      classificationText = buildClassificationTextFromD1(receipt);
    }
  } else {
    classificationText = buildClassificationTextFromD1(receipt);
  }

  // Skip reclassification if amount=0 and no R2 data (can't extract amount from D1 alone)
  if (receipt.amount <= 0 && !r2Available) {
    return {
      result: {
        id: receipt.id,
        vendor_name: receipt.vendor_name,
        status: 'skipped',
        r2Available: false,
        error: 'amount=0 with no R2 data: cannot extract amount',
      },
      newDealsCreated: dealsCreated,
    };
  }

  // Step 2: Re-classify
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

  await env.DB!.prepare(
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
    r2Available,
    newVendor,
    newAmount,
    newCategory: newCategory ?? undefined,
    newConfidence,
  };

  let newDealsCreated = dealsCreated;

  // Step 4: Create deal if we have a freee_receipt_id and haven't hit the limit
  if (receipt.freee_receipt_id && newDealsCreated < maxDeals) {
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
      await env.DB!.prepare(
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

      result.status = dealResult.dealId ? 'deal_created' : 'deal_needs_review';
      result.dealId = dealResult.dealId;
      result.dealStatus = dealResult.status;

      if (dealResult.dealId) {
        newDealsCreated += 1;
      }
    } catch (dealError) {
      // Deal creation failed, but reclassification succeeded
      result.error = `Deal failed: ${dealError instanceof Error ? dealError.message : String(dealError)}`;
      safeLog.warn('[Backfill] Deal creation failed', {
        receiptId: receipt.id,
        error: dealError instanceof Error ? dealError.message : String(dealError),
      });
    }
  }

  return { result, newDealsCreated };
}

// =============================================================================
// API Handler
// =============================================================================

export async function handleReceiptBackfill(
  request: Request,
  env: Env
): Promise<Response> {
  if (!env.DB) {
    return jsonResponse({ error: 'D1 database not configured' }, 500);
  }

  // R2 is optional now — backfill works without it
  const bucket = env.RECEIPTS ?? env.R2 ?? null;

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

  safeLog.info('[Backfill] Starting API backfill', { count: receipts.length, hasR2: !!bucket });

  const results: BackfillResult[] = [];
  let dealsCreated = 0;

  for (const receipt of receipts) {
    try {
      const { result, newDealsCreated } = await backfillReceipt(
        env, bucket, receipt, dealsCreated, MAX_DEALS_PER_RUN
      );
      dealsCreated = newDealsCreated;
      results.push(result);
    } catch (error) {
      results.push({
        id: receipt.id,
        vendor_name: receipt.vendor_name,
        status: 'failed',
        r2Available: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const summary = {
    total: results.length,
    reclassified: results.filter(r => r.status === 'reclassified').length,
    dealsCreated: results.filter(r => r.status === 'deal_created').length,
    dealsNeedReview: results.filter(r => r.status === 'deal_needs_review').length,
    skipped: results.filter(r => r.status === 'skipped').length,
    failed: results.filter(r => r.status === 'failed').length,
    r2Available: results.filter(r => r.r2Available).length,
    r2Missing: results.filter(r => !r.r2Available).length,
  };

  safeLog.info('[Backfill] API backfill completed', summary);

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
 *
 * Works with or without R2 — falls back to D1 metadata.
 */
export async function handleReceiptBackfillCron(env: Env): Promise<void> {
  if (!env.DB) {
    safeLog.warn('[Backfill] D1 not configured, skipping');
    return;
  }

  // R2 is optional — backfill works without it
  const bucket = env.RECEIPTS ?? env.R2 ?? null;
  if (!bucket) {
    safeLog.warn('[Backfill] R2 bucket not configured (will use D1 metadata only)');
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

  safeLog.info('[Backfill] Starting cron backfill', {
    count: receipts.length,
    hasR2: !!bucket,
  });

  let reclassified = 0;
  let dealsCreated = 0;
  let dealsNeedReview = 0;
  let failed = 0;

  for (const receipt of receipts) {
    try {
      const { result, newDealsCreated } = await backfillReceipt(
        env, bucket, receipt, dealsCreated, MAX_DEALS_PER_RUN
      );

      if (result.status === 'deal_created') {
        dealsCreated = newDealsCreated;
      } else if (result.status === 'deal_needs_review') {
        dealsNeedReview += 1;
      } else if (result.status === 'reclassified') {
        reclassified += 1;
      }
    } catch (error) {
      failed += 1;
      safeLog.error('[Backfill] Receipt failed', {
        receiptId: receipt.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  safeLog.info('[Backfill] Cron backfill completed', {
    reclassified,
    dealsCreated,
    dealsNeedReview,
    failed,
    hasR2: !!bucket,
  });

  // Record result to D1 for diagnostics
  try {
    await recordCronRun(env, 'receipt_backfill', 'success', {
      reclassified,
      dealsCreated,
      dealsNeedReview,
      failed,
      total: receipts.length,
    });
  } catch {
    // best-effort
  }
}

// =============================================================================
// Cron diagnostics helper
// =============================================================================

/**
 * Record a cron execution to D1 for diagnostics.
 * Table: cron_runs (created by migration 0027).
 * Fail-safe: silently ignores errors if table doesn't exist yet.
 */
export async function recordCronRun(
  env: Env,
  jobName: string,
  status: 'success' | 'error' | 'skipped',
  details?: Record<string, unknown>,
  error?: string
): Promise<void> {
  if (!env.DB) return;

  try {
    await env.DB.prepare(
      `INSERT INTO cron_runs (job_name, status, details, error_message, executed_at)
       VALUES (?, ?, ?, ?, datetime('now'))`
    ).bind(
      jobName,
      status,
      details ? JSON.stringify(details) : null,
      error ?? null
    ).run();
  } catch {
    // Table may not exist yet — silently ignore
  }
}
