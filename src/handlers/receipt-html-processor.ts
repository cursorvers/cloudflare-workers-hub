/**
 * Receipt HTML Processor
 *
 * Processes HTML-body receipt emails through:
 * - Dedup (SHA-256 hash)
 * - AI classification (stripped text)
 * - R2 WORM storage (with Content-Disposition: attachment)
 * - freee deal creation (when freee upload supported)
 * - Workflow state machine transitions
 */

import type { Env } from '../types';
import { safeLog } from '../utils/log-sanitizer';
import {
  stripHtmlTags,
  type GmailHtmlReceiptEmail,
} from '../services/gmail-receipt-client';
import { classifyReceipt } from '../services/ai-receipt-classifier';
import type { ClassificationResult } from '../services/ai-receipt-classifier';
import { createFreeeClient } from '../services/freee-client';
import { createDealFromReceipt } from '../services/freee-deal-service';
import type { ReceiptInput } from '../services/freee-deal-service';
import { createStateMachine } from '../services/workflow-state-machine';
import { CONFIDENCE } from '../config/confidence-thresholds';
import { convertHtmlReceiptToPdf } from '../services/html-to-pdf-converter';
import { loadCjkFontBytes } from '../services/pdf-font-loader';
import { backupToGoogleDrive, type FreeeReceiptBackup } from '../services/google-drive-backup';

import {
  RETENTION_YEARS,
  DEFAULT_TENANT_ID,
  MAX_DEALS_PER_RUN,
  addYears,
  toIsoDate,
  calculateSha256,
  normalizeVendorFromEmail,
  isEmailLikeVendor,
  hasDuplicateHash,
} from './receipt-poller-utils';

const MAX_TEXT_EVIDENCE_CHARS = 200_000;
const MAX_PDF_TEXT_CHARS = 120_000;

// ── Internal helpers ─────────────────────────────────────────────────

export function htmlProcessedKey(messageId: string): string {
  return `gmail:html_processed:${messageId}`;
}

// ── Main HTML receipt processor ──────────────────────────────────────

export async function processHtmlReceipt(
  env: Env,
  bucket: R2Bucket,
  freeeClient: ReturnType<typeof createFreeeClient>,
  email: GmailHtmlReceiptEmail,
  metrics: { processed: number; skipped: number; failed: number; dealsCreated: number }
): Promise<void> {
  const receiptId = crypto.randomUUID().replace(/-/g, '');
  const rawTextContent = email.htmlBody.plainText || stripHtmlTags(email.htmlBody.html);
  const textContent = rawTextContent.length > MAX_TEXT_EVIDENCE_CHARS
    ? rawTextContent.slice(0, MAX_TEXT_EVIDENCE_CHARS) +
      `

[TRUNCATED: ${rawTextContent.length - MAX_TEXT_EVIDENCE_CHARS} chars omitted]`
    : rawTextContent;
  const pdfTextContent = textContent.length > MAX_PDF_TEXT_CHARS
    ? textContent.slice(0, MAX_PDF_TEXT_CHARS) +
      `

[TRUNCATED FOR PDF: ${textContent.length - MAX_PDF_TEXT_CHARS} chars omitted]`
    : textContent;
  const htmlBytes = new TextEncoder().encode(email.htmlBody.html);
  const fileHash = await calculateSha256(htmlBytes);
  const r2Key = `receipts/${DEFAULT_TENANT_ID}/${receiptId}/receipt.html`;
  const r2KeyTxt = `receipts/${DEFAULT_TENANT_ID}/${receiptId}/receipt.txt`;
  const txtBytes = new TextEncoder().encode(textContent);
  const retentionUntil = addYears(new Date(), RETENTION_YEARS);

  // Dedup by content hash
  const duplicateId = await hasDuplicateHash(env, fileHash);
  if (duplicateId) {
    safeLog.warn('[Gmail Poller] Duplicate HTML receipt detected, skipping', {
      receiptId: duplicateId,
      fileHash,
      messageId: email.messageId,
    });
    metrics.skipped += 1;
    return;
  }

  const fallbackDate = toIsoDate(email.date);
  const fallbackVendor = normalizeVendorFromEmail(email.from || 'Unknown');

  let workflow: ReturnType<typeof createStateMachine> | null = null;

  try {
    await env.DB!.prepare(
      `INSERT INTO receipts (
        id, file_hash, r2_object_key, transaction_date, vendor_name,
        amount, currency, document_type, classification_method,
        classification_confidence, status, retention_until, tenant_id, source_type
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        receiptId, fileHash, r2Key, fallbackDate, fallbackVendor,
        0, 'JPY', 'other', 'ai_assisted',
        0, 'pending_validation', retentionUntil, DEFAULT_TENANT_ID, 'html_body'
      )
      .run();

    workflow = createStateMachine(env, receiptId);
    await workflow.transition('validated', {
      source: 'gmail_html_poll',
      messageId: email.messageId,
    });

    // Classify using stripped text
    const classificationText = [
      `Subject: ${email.subject}`,
      `From: ${email.from}`,
      `Date: ${email.date.toISOString()}`,
      `Source: HTML email body`,
      '',
      'Email Body (text):',
      '---BEGIN EMAIL TEXT---',
      textContent.slice(0, 8000),
      '---END EMAIL TEXT---',
    ].join('\n');

    let classificationResult: ClassificationResult;
    try {
      classificationResult = await classifyReceipt(env, classificationText, {
        tenantId: DEFAULT_TENANT_ID,
        source: 'gmail_html',
        subject: email.subject,
        from: email.from,
      });
    } catch (classificationError) {
      safeLog.warn('[Gmail Poller] HTML classification failed, using fallback', {
        receiptId,
        messageId: email.messageId,
        error: classificationError instanceof Error ? classificationError.message : String(classificationError),
      });
      classificationResult = {
        document_type: 'other',
        vendor_name: fallbackVendor,
        amount: 0,
        currency: 'JPY',
        transaction_date: fallbackDate,
        account_category: undefined,
        tax_type: undefined,
        department: undefined,
        confidence: 0,
        method: 'ai_assisted',
        cache_hit: false,
        amount_extracted: false,
      };
    }

    // Normalize & validate (same as PDF path, confidence cap 0.3→0.6 per 2026-02-09 consensus)
    const rawVendor = classificationResult.vendor_name || fallbackVendor;
    const normalizedVendor = isEmailLikeVendor(rawVendor)
      ? normalizeVendorFromEmail(rawVendor)
      : rawVendor;
    const roundedAmount = Number.isFinite(classificationResult.amount)
      ? Math.round(classificationResult.amount)
      : 0;
    const amountExtracted = classificationResult.amount_extracted ?? (roundedAmount > 0);
    const hasQualityIssue = isEmailLikeVendor(rawVendor) || (roundedAmount === 0 && !amountExtracted);
    const adjustedConfidence = hasQualityIssue
      ? Math.min(classificationResult.confidence, CONFIDENCE.QUALITY_ISSUE_CAP)
      : classificationResult.confidence;

    classificationResult = {
      ...classificationResult,
      transaction_date: classificationResult.transaction_date || fallbackDate,
      vendor_name: normalizedVendor,
      amount: roundedAmount,
      confidence: adjustedConfidence,
      amount_extracted: amountExtracted,
    };

    await env.DB!.prepare(
      `UPDATE receipts SET
        transaction_date = ?, vendor_name = ?, amount = ?,
        currency = ?, document_type = ?, account_category = ?,
        tax_type = ?, department = ?, classification_method = ?,
        classification_confidence = ?
      WHERE id = ?`
    )
      .bind(
        classificationResult.transaction_date,
        classificationResult.vendor_name,
        classificationResult.amount,
        classificationResult.currency || 'JPY',
        classificationResult.document_type || 'other',
        classificationResult.account_category || null,
        classificationResult.tax_type || null,
        classificationResult.department || null,
        classificationResult.method,
        classificationResult.confidence,
        receiptId
      )
      .run();

    await workflow.transition('classified', {
      method: classificationResult.method,
      confidence: classificationResult.confidence,
    });
    await workflow.transition('extracting', { note: 'HTML body - no OCR needed' });
    await workflow.transition('extracted', { note: 'HTML body - no OCR needed' });

    // Empty HTML body → skip before R2 upload (nothing to store)
    if (htmlBytes.byteLength === 0) {
      safeLog.warn('[Gmail Poller] HTML receipt body is empty, skipping', { receiptId });
      await workflow.transition('failed', { reason: 'HTML body is empty' });
      metrics.skipped += 1;
      return;
    }

    await workflow.transition('uploading_r2', { r2Key });

    // Store HTML in R2 with Content-Disposition: attachment (security)
    const htmlR2Result = await bucket.put(r2Key, htmlBytes, {
      httpMetadata: {
        contentType: 'text/html',
        contentDisposition: 'attachment; filename="receipt.html"',
      },
      customMetadata: {
        fileHash,
        messageId: email.messageId,
        retentionUntil,
        tenantId: DEFAULT_TENANT_ID,
        worm: 'true',
        hasExternalReferences: String(email.htmlBody.hasExternalReferences),
      },
      onlyIf: { etagDoesNotMatch: '*' },
    });

    if (!htmlR2Result) {
      safeLog.warn('[Gmail Poller] HTML R2 put returned null (WORM dedup or write issue)', {
        r2Key,
        receiptId,
      });
      const verifyObj = await bucket.head(r2Key);
      if (!verifyObj) {
        safeLog.error('[Gmail Poller] HTML R2 object NOT stored (critical: WORM gap)', {
          r2Key,
          receiptId,
        });
      }
    }

    await workflow.transition('uploaded_r2', { r2Key, size: htmlBytes.byteLength });

    // Also store a plain-text variant for human review (Obsidian-friendly).
    try {
      await bucket.put(r2KeyTxt, txtBytes, {
        httpMetadata: {
          contentType: 'text/plain; charset=utf-8',
          contentDisposition: 'attachment; filename="receipt.txt"',
        },
        customMetadata: {
          fileHash,
          messageId: email.messageId,
          retentionUntil,
          tenantId: DEFAULT_TENANT_ID,
          worm: 'true',
          derivedFrom: 'receipt.html',
        },
        onlyIf: { etagDoesNotMatch: '*' },
      });
    } catch (txtError) {
      safeLog.warn('[Gmail Poller] Failed to store receipt.txt (continuing)', {
        receiptId,
        messageId: email.messageId,
        error: txtError instanceof Error ? txtError.message : String(txtError),
      });
    }

    // External references: keep processing (text-PDF evidence), but mark needs_review for manual verification.
    if (email.htmlBody.hasExternalReferences) {
      safeLog.info('[Gmail Poller] HTML receipt has external references (continuing, needs_review)', {
        receiptId,
        externalRefTypes: email.htmlBody.externalRefTypes,
      });

      // Mark review-needed without bumping retry_count.
      try {
        await env.DB!.prepare(
          `UPDATE receipts
           SET status = 'needs_review',
               error_code = 'HTML_EXTERNAL_REFERENCES',
               error_message = ?,
               updated_at = datetime('now')
           WHERE id = ?`
        ).bind(
          `HTML has external references (${(email.htmlBody.externalRefTypes || []).join(',')})`,
          receiptId
        ).run();
      } catch {
        // best-effort
      }

      try {
        await workflow.transition('needs_review', {
          reason: 'HTML has external references - needs manual verification',
          externalRefTypes: email.htmlBody.externalRefTypes,
        });
      } catch {
        // best-effort
      }
    }

    // Convert HTML → PDF for freee File Box upload (freee only accepts PDF/image/Excel/Word/CSV)
    const pdfFileName = `receipt-${receiptId}.pdf`;
    const idempotencyKey = `gmail:html:${email.messageId}`;

    await workflow.transition('submitting_freee', { fileName: pdfFileName, idempotencyKey });

    const hasCjk = /[　-鿿豈-﫿]/.test(pdfTextContent);
    const fontBytes = hasCjk ? await loadCjkFontBytes(env) : null;

    let pdfBytes: Uint8Array;
    try {
      pdfBytes = await convertHtmlReceiptToPdf(pdfTextContent, {
        subject: email.subject,
        from: email.from,
        date: email.date.toISOString(),
        receiptId,
        fontBytes,
      });
    } catch (conversionError) {
      // If the custom font is invalid/corrupt, retry without it (sanitize-to-ASCII mode).
      if (fontBytes) {
        safeLog.warn('[Gmail Poller] HTML→PDF conversion failed with CJK font, retrying without font', {
          receiptId,
          messageId: email.messageId,
          error: conversionError instanceof Error ? conversionError.message : String(conversionError),
        });
        try {
          pdfBytes = await convertHtmlReceiptToPdf(pdfTextContent, {
            subject: email.subject,
            from: email.from,
            date: email.date.toISOString(),
            receiptId,
            fontBytes: null,
          });
        } catch (fallbackError) {
          safeLog.error('[Gmail Poller] HTML→PDF conversion failed', {
            receiptId,
            messageId: email.messageId,
            error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
          });
          await workflow.recordError(
            fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
            'HTML_PDF_CONVERSION_FAILED',
            { messageId: email.messageId }
          );
          metrics.processed += 1;
          return;
        }
      } else {
        safeLog.error('[Gmail Poller] HTML→PDF conversion failed', {
          receiptId,
          messageId: email.messageId,
          error: conversionError instanceof Error ? conversionError.message : String(conversionError),
        });
        await workflow.recordError(
          conversionError instanceof Error ? conversionError.message : String(conversionError),
          'HTML_PDF_CONVERSION_FAILED',
          { messageId: email.messageId }
        );
        metrics.processed += 1;
        return;
      }
    }


    if (hasCjk && !fontBytes) {
      safeLog.warn('[Gmail Poller] HTML receipt contains CJK characters but no CJK font is configured', {
        receiptId,
        messageId: email.messageId,
        note: 'Set PDF_CJK_FONT_R2_KEY to render Japanese correctly in generated PDFs. Evidence text is still stored as receipt.txt in R2.',
      });
    }

    const pdfBlob = new Blob([pdfBytes], { type: 'application/pdf' });
    const freeeResult = await freeeClient.uploadReceipt(pdfBlob, pdfFileName, idempotencyKey);

    safeLog.info('[Gmail Poller] HTML receipt uploaded to freee as PDF', {
      receiptId,
      freeeReceiptId: freeeResult.receipt.id,
      pdfSizeBytes: pdfBytes.byteLength,
      hasCjk,
    });

    // Deal creation (same as PDF path)
    try {
      if (metrics.dealsCreated < MAX_DEALS_PER_RUN) {
	        const receiptInput: ReceiptInput = {
	          id: receiptId,
	          freee_receipt_id: freeeResult.receipt.id,
	          file_hash: fileHash,
	          vendor_name: classificationResult.vendor_name,
	          amount: classificationResult.amount,
	          currency: classificationResult.currency,
	          transaction_date: classificationResult.transaction_date,
	          account_category: classificationResult.account_category ?? null,
	          classification_confidence: classificationResult.confidence ?? null,
	          tenant_id: DEFAULT_TENANT_ID,
	        };

        const dealResult = await createDealFromReceipt(env, receiptInput);

        try {
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
            receiptId
          ).run();
        } catch {
          // best-effort D1 update
        }

        if (dealResult.status === 'created') {
          metrics.dealsCreated += 1;
        }

        safeLog.info('[Gmail Poller] HTML deal processed', {
          receiptId,
          dealId: dealResult.dealId,
          status: dealResult.status,
          mappingConfidence: dealResult.mappingConfidence,
        });
      } else {
        safeLog.info('[Gmail Poller] HTML deal skipped (rate limit cap reached)', {
          receiptId,
          dealsCreated: metrics.dealsCreated,
          maxDealsPerRun: MAX_DEALS_PER_RUN,
        });
      }
    } catch (dealError) {
      safeLog.warn('[Gmail Poller] HTML deal creation failed (receipt saved)', {
        receiptId,
        freeeReceiptId: freeeResult.receipt.id,
        error: dealError instanceof Error ? dealError.message : String(dealError),
      });
      try {
        await env.DB!.prepare(
          `INSERT INTO receipt_dlq (receipt_id, error_code, error_message, source_type, message_id)
           VALUES (?, ?, ?, 'html_body', ?)`
        ).bind(
          receiptId,
          'HTML_DEAL_CREATION_FAILED',
          dealError instanceof Error ? dealError.message : String(dealError),
          email.messageId
        ).run();
      } catch {
        // DLQ insert is best-effort
      }
    }

    await workflow.complete(String(freeeResult.receipt.id));

    // Backup to Google Drive (non-blocking, same as PDF path)
    try {
      const backupData: FreeeReceiptBackup = {
        receiptId,
        freeeReceiptId: String(freeeResult.receipt.id),
        transactionDate: classificationResult.transaction_date,
        vendorName: classificationResult.vendor_name,
        amount: classificationResult.amount,
        currency: classificationResult.currency || 'JPY',
        status: 'completed',
        createdAt: new Date().toISOString(),
        freeeApiResponse: freeeResult,
      };
      const driveResult = await backupToGoogleDrive(env, backupData);
      safeLog.info('[Gmail Poller] HTML receipt backed up to Google Drive', {
        receiptId,
        driveFileId: driveResult.fileId,
      });
    } catch (driveError) {
      safeLog.warn('[Gmail Poller] HTML Google Drive backup failed', {
        receiptId,
        error: driveError instanceof Error ? driveError.message : String(driveError),
      });
    }

    // Mark as processed
    if (env.CACHE) {
      try {
        await env.CACHE.put(htmlProcessedKey(email.messageId), '1', {
          expirationTtl: 60 * 60 * 24 * 30,
        });
      } catch {
        // best-effort
      }
    }

    safeLog.info('[Gmail Poller] HTML receipt processed', {
      receiptId,
      freeeReceiptId: freeeResult.receipt.id,
      messageId: email.messageId,
    });
    metrics.processed += 1;
  } catch (error) {
    metrics.failed += 1;
    const message = error instanceof Error ? error.message : String(error);
    safeLog.error('[Gmail Poller] Failed to process HTML receipt', {
      receiptId,
      messageId: email.messageId,
      error: message,
    });

    if (workflow) {
      try {
        await workflow.recordError(message, 'HTML_POLL_FAILED', { messageId: email.messageId });
        await workflow.transition('failed', { reason: message });
      } catch {
        // best-effort
      }
    }
  }
}

export interface RetryHtmlReceiptsResult {
  readonly retried: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly skipped: number;
}

/**
 * Retry failed HTML receipts where the failure was transient (i.e. an error_code exists).
 *
 * Note:
 * - Receipts blocked for "manual review" often transition to `failed` without `recordError()`,
 *   so they will not be retried here (error_code is NULL).
 * - This is intentionally conservative to avoid creating unintended freee uploads/deals.
 */
export async function retryFailedHtmlReceipts(
  env: Env,
  bucket: R2Bucket,
  freeeClient: ReturnType<typeof createFreeeClient>,
  limit: number = 5,
): Promise<RetryHtmlReceiptsResult> {
  if (!env.DB) {
    return { retried: 0, succeeded: 0, failed: 0, skipped: 0 };
  }

  const rows = await env.DB.prepare(
    `SELECT
       id, r2_object_key, file_hash, vendor_name, amount, currency,
       transaction_date, account_category, classification_confidence,
       tenant_id, retry_count, error_code
     FROM receipts
     WHERE source_type = 'html_body'
       AND status = 'failed'
       AND freee_receipt_id IS NULL
       AND error_code IS NOT NULL
       AND retry_count < 3
     ORDER BY updated_at DESC
     LIMIT ?`,
  ).bind(limit).all<{
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
    retry_count: number;
    error_code: string;
  }>();

  const result: { retried: number; succeeded: number; failed: number; skipped: number } = {
    retried: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
  };

  for (const r of rows.results ?? []) {
    result.retried += 1;

    try {
      const obj = await bucket.get(r.r2_object_key);
      if (!obj) {
        result.skipped += 1;
        continue;
      }

      const html = await obj.text();
      const textContent = stripHtmlTags(html).slice(0, 8000);

      const workflow = createStateMachine(env, r.id);
      try {
        // failed -> submitting_freee is allowed by the workflow rules
        await workflow.transition('submitting_freee', { source: 'html_retry' });
      } catch {
        // best-effort
      }

      const hasCjk = /[　-鿿豈-﫿]/.test(textContent);
      const fontBytes = hasCjk ? await loadCjkFontBytes(env) : null;

      let pdfBytes: Uint8Array;
      try {
        pdfBytes = await convertHtmlReceiptToPdf(textContent, {
          subject: `Retry: ${r.vendor_name}`,
          from: 'retry',
          date: new Date().toISOString(),
          receiptId: r.id,
          fontBytes,
        });
      } catch (conversionError) {
        if (fontBytes) {
          safeLog.warn('[Gmail Poller] HTML retry conversion failed with CJK font, retrying without font', {
            receiptId: r.id,
            error: conversionError instanceof Error ? conversionError.message : String(conversionError),
          });
          pdfBytes = await convertHtmlReceiptToPdf(textContent, {
            subject: `Retry: ${r.vendor_name}`,
            from: 'retry',
            date: new Date().toISOString(),
            receiptId: r.id,
            fontBytes: null,
          });
        } else {
          throw conversionError;
        }
      }

      if (hasCjk && !fontBytes) {
        safeLog.warn('[Gmail Poller] HTML retry contains CJK but no CJK font is configured', {
          receiptId: r.id,
          note: 'Set PDF_CJK_FONT_R2_KEY to render Japanese correctly in generated PDFs.',
        });
      }

      const idempotencyKey = `gmail:html:retry:${r.id}`;
      const pdfFileName = `receipt-${r.id}.pdf`;
      const pdfBlob = new Blob([pdfBytes], { type: 'application/pdf' });

      const freeeResult = await freeeClient.uploadReceipt(pdfBlob, pdfFileName, idempotencyKey);
      await workflow.complete(String(freeeResult.receipt.id));

      // Best-effort deal creation (consistent with main HTML path)
      if ((r.currency || 'JPY') === 'JPY' && Number(r.amount) > 0) {
        const receiptInput: ReceiptInput = {
          id: r.id,
          freee_receipt_id: freeeResult.receipt.id,
          retry_link_if_existing: true,
          file_hash: r.file_hash,
          vendor_name: r.vendor_name,
          amount: r.amount,
          currency: r.currency || 'JPY',
          transaction_date: r.transaction_date,
          account_category: r.account_category ?? null,
          classification_confidence: r.classification_confidence ?? null,
          tenant_id: r.tenant_id || DEFAULT_TENANT_ID,
        };

        const dealResult = await createDealFromReceipt(env, receiptInput);
        if (dealResult.dealId) {
          await env.DB.prepare(
            `UPDATE receipts
             SET freee_deal_id = ?, freee_partner_id = ?,
                 account_item_id = ?, tax_code = ?,
                 account_mapping_confidence = ?,
                 account_mapping_method = ?,
                 updated_at = datetime('now')
             WHERE id = ?`,
          ).bind(
            dealResult.dealId,
            dealResult.partnerId,
            dealResult.accountItemId ?? null,
            dealResult.taxCode ?? null,
            dealResult.mappingConfidence,
            dealResult.mappingMethod ?? null,
            r.id,
          ).run();
        }
      }

      result.succeeded += 1;
    } catch (error) {
      result.failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      safeLog.warn('[Gmail Poller] HTML retry failed', { receiptId: r.id, error: message });
      try {
        const workflow = createStateMachine(env, r.id);
        await workflow.recordError(message, 'HTML_RETRY_FAILED');
      } catch {
        // best-effort
      }
    }
  }

  return result;
}
