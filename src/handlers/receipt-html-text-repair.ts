import type { Env } from '../types';
import { safeLog } from '../utils/log-sanitizer';
import { stripHtmlTags } from '../services/gmail-receipt-client';
import { classifyReceipt } from '../services/ai-receipt-classifier';

type HtmlReceiptRow = {
  id: string;
  r2_object_key: string;
  vendor_name: string;
  amount: number;
  currency: string;
  transaction_date: string;
  account_category: string | null;
  classification_confidence: number | null;
  freee_receipt_id: string | number | null;
  freee_deal_id: string | number | null;
  status: string;
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function getReceiptBucket(env: Env): R2Bucket | null {
  return env.RECEIPTS ?? env.R2 ?? null;
}

function toBool(value: string | null, fallback: boolean): boolean {
  if (value === null) return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

function normalizeCurrency(value: unknown): string {
  const raw = typeof value === 'string' ? value : String(value ?? 'JPY');
  const cur = raw.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(cur) ? cur : 'JPY';
}

function buildClassificationText(row: HtmlReceiptRow, textContent: string): string {
  const header = [
    `From: ${row.vendor_name}`,
    `Date: ${row.transaction_date}`,
    `Amount: ${row.amount} ${row.currency || 'JPY'}`,
    '',
  ].join('\n');

  // Keep the text size bounded for cache + model.
  const body = textContent.length > 8000 ? textContent.slice(0, 8000) : textContent;
  return header + body;
}

export async function handleRepairHtmlReceiptText(
  request: Request,
  env: Env
): Promise<Response> {
  if (!env.DB) return json({ error: 'DB not configured' }, 503);

  const bucket = getReceiptBucket(env);
  if (!bucket) return json({ error: 'R2 bucket not configured' }, 500);

  const url = new URL(request.url);
  const limitRaw = url.searchParams.get('limit') ?? '20';
  const limit = Math.max(1, Math.min(100, Number.parseInt(limitRaw, 10) || 20));
  const dry_run = toBool(url.searchParams.get('dry_run'), true);
  const reclassify = toBool(url.searchParams.get('reclassify'), true);
  const only_missing_text = toBool(url.searchParams.get('only_missing_text'), true);

  const rows = await env.DB.prepare(
    `SELECT id, r2_object_key, vendor_name, amount, currency, transaction_date,
            account_category, classification_confidence,
            freee_receipt_id, freee_deal_id, status
     FROM receipts
     WHERE source_type = 'html_body'
     ORDER BY created_at DESC
     LIMIT ?`
  ).bind(limit).all<HtmlReceiptRow>();

  let scanned = 0;
  let wrote_text = 0;
  let would_write_text = 0;
  let reclassified = 0;
  let needs_review = 0;
  let skipped = 0;
  let errors = 0;

  const results: Array<{
    id: string;
    action:
      | 'ok'
      | 'wrote_text'
      | 'would_write_text'
      | 'reclassified'
      | 'needs_review'
      | 'skipped'
      | 'error';
    note?: string;
    r2_object_key?: string;
    text_key?: string;
    old?: { amount: number; currency: string; vendor_name: string };
    next?: { amount: number; currency: string; vendor_name: string };
    freee_deal_id?: string | number | null;
    freee_receipt_id?: string | number | null;
  }> = [];

  for (const row of rows.results ?? []) {
    scanned += 1;

    const htmlKey = String(row.r2_object_key || '');
    if (!htmlKey.endsWith('.html')) {
      skipped += 1;
      results.push({
        id: row.id,
        action: 'skipped',
        note: 'r2_object_key is not an .html receipt',
        r2_object_key: htmlKey,
      });
      continue;
    }

    const textKey = htmlKey.replace(/\.html$/i, '.txt');

    let hasText = false;
    try {
      const head = await bucket.head(textKey);
      hasText = Boolean(head);
    } catch {
      // Best-effort.
      hasText = false;
    }

    if (only_missing_text && hasText && !reclassify) {
      results.push({ id: row.id, action: 'ok', r2_object_key: htmlKey, text_key: textKey });
      continue;
    }

    let textContent: string | null = null;

    try {
      if (!hasText) {
        if (dry_run) {
          would_write_text += 1;
          results.push({
            id: row.id,
            action: 'would_write_text',
            r2_object_key: htmlKey,
            text_key: textKey,
            freee_deal_id: row.freee_deal_id,
            freee_receipt_id: row.freee_receipt_id,
          });
        } else {
          const htmlObj = await bucket.get(htmlKey);
          if (!htmlObj) {
            skipped += 1;
            results.push({
              id: row.id,
              action: 'skipped',
              note: 'R2 html object missing',
              r2_object_key: htmlKey,
            });
            continue;
          }

          const htmlBuf = await htmlObj.arrayBuffer();
          const html = new TextDecoder('utf-8', { fatal: false }).decode(htmlBuf);
          textContent = stripHtmlTags(html);

          const textBytes = new TextEncoder().encode(textContent);
          await bucket.put(textKey, textBytes, {
            httpMetadata: {
              contentType: 'text/plain; charset=utf-8',
              contentDisposition: 'attachment; filename="receipt.txt"',
            },
            customMetadata: {
              source: 'html_body_text_backfill',
              receiptId: row.id,
            },
          });

          wrote_text += 1;
          results.push({
            id: row.id,
            action: 'wrote_text',
            r2_object_key: htmlKey,
            text_key: textKey,
            freee_deal_id: row.freee_deal_id,
            freee_receipt_id: row.freee_receipt_id,
          });

          hasText = true;
        }
      }

      if (!reclassify) {
        continue;
      }

      if (textContent === null) {
        // Prefer textKey if present, else derive from htmlKey.
        const textObj = hasText ? await bucket.get(textKey) : null;
        if (textObj) {
          const buf = await textObj.arrayBuffer();
          textContent = new TextDecoder('utf-8', { fatal: false }).decode(buf);
        } else {
          const htmlObj = await bucket.get(htmlKey);
          if (!htmlObj) {
            skipped += 1;
            results.push({
              id: row.id,
              action: 'skipped',
              note: 'R2 html/text object missing (cannot reclassify)',
              r2_object_key: htmlKey,
              text_key: textKey,
            });
            continue;
          }
          const htmlBuf = await htmlObj.arrayBuffer();
          const html = new TextDecoder('utf-8', { fatal: false }).decode(htmlBuf);
          textContent = stripHtmlTags(html);
        }
      }

      const classificationText = buildClassificationText(row, textContent);

      const classification = await classifyReceipt(env, classificationText, {
        vendor_name: row.vendor_name,
        amount: row.amount,
        currency: row.currency,
        transaction_date: row.transaction_date,
        tenant_id: 'default',
      });

      const nextVendor = (classification.vendor_name || row.vendor_name || 'Unknown').toString().trim() || row.vendor_name;
      const nextAmount = classification.amount > 0 ? Math.round(classification.amount) : row.amount;
      const nextCurrency = normalizeCurrency(classification.currency || row.currency || 'JPY');
      const nextCategory = classification.account_category || row.account_category;
      const nextConfidence = classification.confidence ?? row.classification_confidence ?? null;

      const shouldNeedsReview = nextCurrency !== 'JPY';
      const nextStatus = shouldNeedsReview ? 'needs_review' : row.status;
      const nextErrorCode = shouldNeedsReview ? 'NON_JPY_CURRENCY' : null;
      const nextErrorMessage = shouldNeedsReview
        ? `non-JPY currency detected (${nextCurrency}); manual review required${row.freee_deal_id ? ' (existing freee_deal_id present)' : ''}`
        : null;

      if (!dry_run) {
        await env.DB.prepare(
          `UPDATE receipts
           SET vendor_name = ?, amount = ?, currency = ?, account_category = ?,
               classification_confidence = ?, classification_method = ?,
               status = ?, error_code = ?, error_message = ?,
               updated_at = datetime('now')
           WHERE id = ?`
        ).bind(
          nextVendor,
          nextAmount,
          nextCurrency,
          nextCategory,
          nextConfidence,
          classification.method,
          nextStatus,
          nextErrorCode,
          nextErrorMessage,
          row.id
        ).run();
      }

      reclassified += 1;
      if (shouldNeedsReview) needs_review += 1;

      results.push({
        id: row.id,
        action: shouldNeedsReview ? 'needs_review' : 'reclassified',
        r2_object_key: htmlKey,
        text_key: textKey,
        old: { amount: row.amount, currency: row.currency, vendor_name: row.vendor_name },
        next: { amount: nextAmount, currency: nextCurrency, vendor_name: nextVendor },
        freee_deal_id: row.freee_deal_id,
        freee_receipt_id: row.freee_receipt_id,
      });
    } catch (error) {
      errors += 1;
      safeLog(env, 'warn', '[RepairHtmlReceiptText] failed', {
        receiptId: row.id,
        r2Key: htmlKey,
        error: error instanceof Error ? error.message : String(error),
      });
      results.push({
        id: row.id,
        action: 'error',
        note: error instanceof Error ? error.message : String(error),
        r2_object_key: htmlKey,
        text_key: textKey,
        freee_deal_id: row.freee_deal_id,
        freee_receipt_id: row.freee_receipt_id,
      });
    }
  }
  return json({
    success: true,
    dry_run,
    reclassify,
    only_missing_text,
    scanned,
    wrote_text,
    would_write_text,
    reclassified,
    needs_review,
    skipped,
    errors,
    results,
  });
}
