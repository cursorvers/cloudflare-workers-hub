import type { Env } from '../types';
import { safeLog } from '../utils/log-sanitizer';
import { createFreeeClient, ApiError } from '../services/freee-client';
import { convertHtmlReceiptToPdf } from '../services/html-to-pdf-converter';
import { loadCjkFontBytes } from '../services/pdf-font-loader';

export interface ReceiptLinkWatchdogResult {
  readonly scanned: number;
  readonly ok: number;
  readonly attempted: number;
  readonly errors: number;
  readonly reuploaded: number;
}

function isReceiptDeletedError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return /証憑は既に削除されています|already deleted|deleted/i.test(msg);
}

function basename(key: string): string {
  const parts = String(key || '').split('/').filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : 'receipt.bin';
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function stripHtmlToText(html: string): string {
  // Best-effort: keep it deterministic and avoid heavy parsing.
  return String(html || '')
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\s*\/p\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

async function buildPdfFromHtmlReceipt(env: Env, bucket: R2Bucket, r2HtmlKey: string): Promise<Uint8Array> {
  // Prefer receipt.txt (stored alongside receipt.html).
  const txtKey = r2HtmlKey.replace(/receipt\.html$/i, 'receipt.txt');
  let textContent: string | null = null;

  try {
    const txtObj = await bucket.get(txtKey);
    if (txtObj) {
      textContent = await txtObj.text();
    }
  } catch {
    // best-effort
  }

  if (!textContent) {
    const htmlObj = await bucket.get(r2HtmlKey);
    if (!htmlObj) {
      throw new Error(`R2 object not found: ${r2HtmlKey}`);
    }
    const html = await htmlObj.text();
    textContent = stripHtmlToText(html);
  }

  // Match receipt-html-processor behavior: keep PDFs bounded.
  const MAX_PDF_TEXT_CHARS = 120_000;
  const boundedText = textContent.length > MAX_PDF_TEXT_CHARS
    ? `${textContent.slice(0, MAX_PDF_TEXT_CHARS)}\n\n[TRUNCATED FOR PDF: ${textContent.length - MAX_PDF_TEXT_CHARS} chars omitted]`
    : textContent;

  const fontBytes = await loadCjkFontBytes(env);
  try {
    return await convertHtmlReceiptToPdf(boundedText, {
      receiptId: undefined,
      fontBytes,
    });
  } catch (error) {
    // Fail-soft: retry without custom font if it was the source of failure.
    if (fontBytes) {
      safeLog.warn('[ReceiptLinkWatchdog] PDF conversion failed with custom font; retrying without font', {
        error: error instanceof Error ? error.message : String(error),
      });
      return await convertHtmlReceiptToPdf(boundedText, { receiptId: undefined, fontBytes: null });
    }
    throw error;
  }
}

/**
 * Best-effort repair: ensure freee receipts are attached to their deals.
 *
 * Conservative + idempotent:
 * - Only operates on receipts that already have both `freee_receipt_id` and `freee_deal_id`.
 * - If freee reports the receipt is deleted, re-upload from R2 (or re-PDF HTML) and re-link.
 */
export async function runReceiptLinkWatchdog(
  env: Env,
  options?: { limit?: number; days?: number }
): Promise<ReceiptLinkWatchdogResult> {
  if (!env.DB) {
    return { scanned: 0, ok: 0, attempted: 0, errors: 0, reuploaded: 0 };
  }

  const limit = Math.max(1, Math.min(50, options?.limit ?? 12));
  const days = Math.max(1, Math.min(30, options?.days ?? 7));

  const rows = await env.DB.prepare(
    `SELECT id, freee_receipt_id, freee_deal_id, r2_object_key
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
    .all<{ id: string; freee_receipt_id: string; freee_deal_id: number; r2_object_key: string }>();

  const freeeClient = createFreeeClient(env);
  const bucket = env.RECEIPTS ?? env.R2;

  let scanned = 0;
  let ok = 0;
  let attempted = 0;
  let errors = 0;
  let reuploaded = 0;

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
      const msg = error instanceof Error ? error.message : String(error);

      // Receipt deleted on freee: re-upload evidence then re-link.
      if (bucket && isReceiptDeletedError(error)) {
        try {
          const key = String(r.r2_object_key || '').trim();
          if (!key) {
            throw new Error('missing r2_object_key');
          }

          let pdfBytes: Uint8Array;
          if (/\.pdf$/i.test(key)) {
            const obj = await bucket.get(key);
            if (!obj) throw new Error(`R2 object not found: ${key}`);
            const ab = await obj.arrayBuffer();
            pdfBytes = new Uint8Array(ab);
          } else if (/receipt\.html$/i.test(key)) {
            pdfBytes = await buildPdfFromHtmlReceipt(env, bucket, key);
          } else {
            // Unknown type: attempt to upload as-is (best-effort).
            const obj = await bucket.get(key);
            if (!obj) throw new Error(`R2 object not found: ${key}`);
            const ab = await obj.arrayBuffer();
            pdfBytes = new Uint8Array(ab);
          }

          const fileName = /\.pdf$/i.test(key) ? basename(key) : `receipt_${r.id}.pdf`;
          const uploadRes = await freeeClient.uploadReceipt(
            new Blob([bytesToArrayBuffer(pdfBytes)], { type: 'application/pdf' }),
            fileName,
            `reupload:${r.id}:${receiptId}`
          );

          const newFreeeReceiptId = String(uploadRes.receipt.id);

          await env.DB.prepare(
            `UPDATE receipts SET freee_receipt_id = ?, updated_at = datetime('now') WHERE id = ?`
          )
            .bind(newFreeeReceiptId, r.id)
            .run();

          // Keep idempotency table in sync (best-effort)
          await env.DB.prepare(
            `UPDATE receipt_deals SET freee_receipt_id = ? WHERE receipt_id = ?`
          )
            .bind(newFreeeReceiptId, r.id)
            .run()
            .catch(() => { /* best-effort */ });

          reuploaded += 1;
          await freeeClient.linkReceiptToDeal(Number.parseInt(newFreeeReceiptId, 10), dealId);
          ok += 1;
          continue;
        } catch (repairError) {
          errors += 1;
          safeLog.warn('[ReceiptLinkWatchdog] Repair attempt failed after receipt-deleted error', {
            receiptRowId: r.id,
            freeeReceiptId: receiptId,
            freeeDealId: dealId,
            error: repairError instanceof Error ? repairError.message : String(repairError),
          });
          continue;
        }
      }

      errors += 1;
      safeLog.warn('[ReceiptLinkWatchdog] Failed to ensure receipt is linked to deal', {
        receiptRowId: r.id,
        freeeReceiptId: receiptId,
        freeeDealId: dealId,
        error: msg,
        status: error instanceof ApiError ? error.status : undefined,
      });
    }
  }

  return { scanned, ok, attempted, errors, reuploaded };
}
