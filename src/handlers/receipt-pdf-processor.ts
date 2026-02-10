/**
 * Receipt PDF Processor
 *
 * Processes PDF attachments from Gmail receipt emails through:
 * - Dedup (SHA-256 hash)
 * - AI classification
 * - R2 WORM storage
 * - freee File Box upload + deal creation
 * - Google Drive backup
 * - Workflow state machine transitions
 */

import type { Env } from '../types';
import { safeLog } from '../utils/log-sanitizer';
import {
  fetchReceiptEmails,
  type GmailReceiptEmail,
  type GmailReceiptAttachment,
  type ShouldDownloadAttachment,
} from '../services/gmail-receipt-client';
import { classifyReceipt } from '../services/ai-receipt-classifier';
import type { ClassificationResult } from '../services/ai-receipt-classifier';
import { createFreeeClient } from '../services/freee-client';
import { createDealFromReceipt } from '../services/freee-deal-service';
import type { ReceiptInput } from '../services/freee-deal-service';
import { createStateMachine } from '../services/workflow-state-machine';
import { backupToGoogleDrive, type FreeeReceiptBackup } from '../services/google-drive-backup';
import { maybeExtractPdfTextForClassification } from '../services/pdf-text-extraction';
import { CONFIDENCE } from '../config/confidence-thresholds';

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
  normalizeFileName,
} from './receipt-poller-utils';

// ── PDF text extraction metrics type ─────────────────────────────────
export interface PdfTextMetrics {
  attempted: number;
  extracted: number;
  failed: number;
  skipped: number;
  notAttempted: number;
  reasons: Record<string, number>;
  totalElapsedMs: number;
}

// ── Internal helpers ─────────────────────────────────────────────────

function buildIdempotencyKey(messageId: string, attachmentId: string): string {
  return `gmail:${messageId}:${attachmentId}`;
}

export function processedAttachmentKey(messageId: string, attachmentId: string): string {
  return `gmail:processed:${messageId}:${attachmentId}`;
}

export function buildClassificationText(
  email: GmailReceiptEmail,
  attachment: GmailReceiptAttachment,
  extractedPdfText?: string
): string {
  const parts = [
    `Subject: ${email.subject}`,
    `From: ${email.from}`,
    `Date: ${email.date.toISOString()}`,
    `Attachment: ${attachment.filename}`,
  ];
  if (extractedPdfText && extractedPdfText.trim().length > 0) {
    parts.push('');
    parts.push('PDF Text (extracted):');
    parts.push('---BEGIN PDF TEXT---');
    parts.push(extractedPdfText);
    parts.push('---END PDF TEXT---');
  }
  return parts.join('\n');
}

// ── Retry helpers ────────────────────────────────────────────────────

function isRateLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /429|rate limit|too many requests|quota/i.test(message);
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Gmail fetch with retry ───────────────────────────────────────────

export async function fetchReceiptEmailsWithRetry(
  env: Env,
  options: {
    query?: string;
    maxResults?: number;
    newerThan?: string;
    shouldDownloadAttachment?: ShouldDownloadAttachment;
  } = {}
): Promise<GmailReceiptEmail[]> {
  const config = {
    clientId: env.GMAIL_CLIENT_ID!,
    clientSecret: env.GMAIL_CLIENT_SECRET!,
    refreshToken: env.GMAIL_REFRESH_TOKEN!,
  };

  let attempt = 0;
  const maxRetries = 3;
  while (true) {
    try {
      return await fetchReceiptEmails(config, options);
    } catch (error) {
      attempt += 1;
      if (!isRateLimitError(error) || attempt > maxRetries) {
        throw error;
      }
      const waitTime = Math.min(1000 * Math.pow(2, attempt), 15000);
      safeLog.warn('[Gmail Poller] Rate limited by Gmail API, backing off', {
        attempt,
        waitTime,
      });
      await delay(waitTime);
    }
  }
}

// ── Main PDF attachment processor ────────────────────────────────────

export async function processAttachment(
  env: Env,
  bucket: R2Bucket,
  freeeClient: ReturnType<typeof createFreeeClient>,
  email: GmailReceiptEmail,
  attachment: GmailReceiptAttachment,
  metrics: { processed: number; skipped: number; failed: number; dealsCreated: number },
  pdfTextMetrics: PdfTextMetrics
): Promise<void> {
  const attachmentId = attachment.attachmentId;
  const receiptId = crypto.randomUUID().replace(/-/g, '');
  const safeFileName = normalizeFileName(attachment.filename || 'receipt.pdf', `${receiptId}.pdf`);
  const r2Key = `receipts/${DEFAULT_TENANT_ID}/${receiptId}/${safeFileName}`;
  const retentionUntil = addYears(new Date(), RETENTION_YEARS);
  const idempotencyKey = buildIdempotencyKey(email.messageId, attachmentId);

  const fileHash = await calculateSha256(attachment.data);
  const duplicateId = await hasDuplicateHash(env, fileHash);
  if (duplicateId) {
    safeLog.warn('[Gmail Poller] Duplicate receipt detected, skipping', {
      receiptId: duplicateId,
      fileHash,
      messageId: email.messageId,
      attachmentId,
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
        id,
        file_hash,
        r2_object_key,
        transaction_date,
        vendor_name,
        amount,
        currency,
        document_type,
        classification_method,
        classification_confidence,
        status,
        retention_until,
        tenant_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        receiptId,
        fileHash,
        r2Key,
        fallbackDate,
        fallbackVendor,
        0,
        'JPY',
        'other',
        'ai_assisted',
        0,
        'pending_validation',
        retentionUntil,
        DEFAULT_TENANT_ID
      )
      .run();

    workflow = createStateMachine(env, receiptId);

    await workflow.transition('validated', {
      source: 'gmail_poll',
      messageId: email.messageId,
      attachmentId,
    });

    let classificationResult: ClassificationResult;
    try {
      const extracted = await maybeExtractPdfTextForClassification(
        env,
        attachment.data,
        {
          receiptId,
          messageId: email.messageId,
          attachmentId,
          fileName: attachment.filename,
        }
      );

      const useExtractedTextForClassification = env.PDF_TEXT_EXTRACTION_USE_FOR_CLASSIFICATION === 'true';
      const classificationMetadata: Record<string, unknown> = {
        // Keep prompt/cache stable: avoid volatile per-message identifiers.
        tenantId: DEFAULT_TENANT_ID,
        source: 'gmail',
        subject: email.subject,
        from: email.from,
        attachmentFileName: attachment.filename,
      };
      // Only attach pdfText* metadata when we actually use it for classification.
      // Otherwise we'd fragment the KV classification cache for no benefit.
      if (useExtractedTextForClassification && extracted.attempted) {
        classificationMetadata.pdfTextExtracted = extracted.extracted;
        classificationMetadata.pdfTextPages = extracted.totalPages;
        classificationMetadata.pdfTextElapsedMs = extracted.elapsedMs;
        classificationMetadata.pdfTextReason = extracted.reason;
      }

      // PDF text extraction metrics (aggregate per poll run)
      if (extracted.reason) {
        pdfTextMetrics.reasons[extracted.reason] = (pdfTextMetrics.reasons[extracted.reason] || 0) + 1;
      }
      if (extracted.attempted) {
        pdfTextMetrics.attempted += 1;
        if (extracted.extracted) {
          pdfTextMetrics.extracted += 1;
          pdfTextMetrics.totalElapsedMs += extracted.elapsedMs ?? 0;
        } else {
          pdfTextMetrics.failed += extracted.reason === 'error' ? 1 : 0;
          pdfTextMetrics.skipped += extracted.reason === 'error' ? 0 : 1;
        }
      } else {
        // disabled/sampled_out/empty/too_large/not_pdf all return attempted=false.
        if (extracted.reason === 'disabled' || extracted.reason === 'sampled_out') {
          pdfTextMetrics.notAttempted += 1;
        } else {
          pdfTextMetrics.skipped += 1;
        }
      }

      classificationResult = await classifyReceipt(
        env,
        buildClassificationText(
          email,
          attachment,
          useExtractedTextForClassification && extracted.extracted ? extracted.text : undefined
        ),
        classificationMetadata
      );
    } catch (classificationError) {
      safeLog.warn('[Gmail Poller] Classification failed, using fallback', {
        receiptId,
        messageId: email.messageId,
        attachmentId,
        error: classificationError instanceof Error
          ? classificationError.message
          : String(classificationError),
      });
      if (workflow) {
        await workflow.recordError(
          classificationError instanceof Error
            ? classificationError.message
            : String(classificationError),
          'CLASSIFICATION_FAILED',
          { messageId: email.messageId, attachmentId }
        );
      }
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

    // Normalize vendor name: if AI returned an email-like string, extract display name
    const rawVendor = classificationResult.vendor_name || fallbackVendor;
    const normalizedVendor = isEmailLikeVendor(rawVendor)
      ? normalizeVendorFromEmail(rawVendor)
      : rawVendor;

    const roundedAmount = Number.isFinite(classificationResult.amount)
      ? Math.round(classificationResult.amount)
      : 0;

    // Output validation: low-quality results get reduced confidence (cap raised 0.3→0.6 per 2026-02-09 consensus)
    const vendorWasEmail = isEmailLikeVendor(rawVendor);
    const amountIsZero = roundedAmount === 0;
    const amountExtracted = classificationResult.amount_extracted ?? (roundedAmount > 0);
    const hasQualityIssue = vendorWasEmail || (amountIsZero && !amountExtracted);
    const adjustedConfidence = hasQualityIssue
      ? Math.min(classificationResult.confidence, CONFIDENCE.QUALITY_ISSUE_CAP)
      : classificationResult.confidence;

    if (hasQualityIssue) {
      safeLog.warn('[Gmail Poller] Classification quality issue detected', {
        receiptId,
        vendorWasEmail,
        amountIsZero,
        amountExtracted,
        rawVendor,
        normalizedVendor,
        originalConfidence: classificationResult.confidence,
        adjustedConfidence,
      });
    }

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
        transaction_date = ?,
        vendor_name = ?,
        amount = ?,
        currency = ?,
        document_type = ?,
        account_category = ?,
        tax_type = ?,
        department = ?,
        classification_method = ?,
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
      cacheHit: classificationResult.cache_hit,
    });

    await workflow.transition('extracting', {
      note: 'Gmail PDF ingestion - OCR skipped',
    });
    await workflow.transition('extracted', {
      note: 'Gmail PDF ingestion - OCR skipped',
    });

    await workflow.transition('uploading_r2', { r2Key });

    const r2Result = await bucket.put(r2Key, attachment.data, {
      httpMetadata: {
        contentType: attachment.mimeType || 'application/pdf',
      },
      customMetadata: {
        fileHash,
        originalName: safeFileName,
        messageId: email.messageId,
        attachmentId,
        retentionUntil,
        tenantId: DEFAULT_TENANT_ID,
        worm: 'true',
      },
      onlyIf: { etagDoesNotMatch: '*' },
    });

    // Verify R2 write succeeded. onlyIf returns null when condition fails
    // (object already exists with WORM). null is OK for WORM idempotency.
    // But we should log it for diagnostics.
    if (!r2Result) {
      safeLog.warn('[Gmail Poller] R2 put returned null (WORM dedup or write issue)', {
        r2Key,
        receiptId,
        messageId: email.messageId,
      });
      // Verify the object actually exists
      const verifyObj = await bucket.head(r2Key);
      if (!verifyObj) {
        safeLog.error('[Gmail Poller] R2 object NOT stored (critical: WORM gap)', {
          r2Key,
          receiptId,
        });
        // Continue processing — receipt is in freee File Box even without R2 copy
      }
    }

    await workflow.transition('uploaded_r2', {
      r2Key,
      size: attachment.size,
    });

    await workflow.transition('submitting_freee', {
      fileName: safeFileName,
      idempotencyKey,
    });

    // Ensure BlobPart uses a concrete ArrayBuffer (not SharedArrayBuffer) for TS + runtime safety.
    const fileBuf = new ArrayBuffer(attachment.data.byteLength);
    new Uint8Array(fileBuf).set(attachment.data);
    const fileBlob = new Blob([fileBuf], {
      type: attachment.mimeType || 'application/pdf',
    });
    const freeeResult = await freeeClient.uploadReceipt(
      fileBlob,
      safeFileName,
      idempotencyKey
    );

    // Attempt automatic deal creation (fail-open: receipt is already in freee File Box)
    // 2026-02-09: amount=0 gate REMOVED. Create deals regardless (as needs_review if low confidence).
    // Rate limit guard: cap deal creation per run to stay within freee 300 req/hr
    let dealStatus: 'created' | 'needs_review' | 'skipped' | 'failed' = 'skipped';
    try {
      if (metrics.dealsCreated < MAX_DEALS_PER_RUN) {
        const receiptInput: ReceiptInput = {
          id: receiptId,
          freee_receipt_id: freeeResult.receipt.id,
          file_hash: fileHash,
          vendor_name: classificationResult.vendor_name,
          amount: classificationResult.amount,
          transaction_date: classificationResult.transaction_date,
          account_category: classificationResult.account_category ?? null,
          classification_confidence: classificationResult.confidence ?? null,
          tenant_id: DEFAULT_TENANT_ID,
        };

        const dealResult = await createDealFromReceipt(env, receiptInput);
        dealStatus = dealResult.status;

        // Update receipts D1 record with deal fields
        try {
          await env.DB!.prepare(
            `UPDATE receipts
             SET freee_deal_id = ?, freee_partner_id = ?,
                 account_item_id = ?, tax_code = ?,
                 account_mapping_confidence = ?,
                 account_mapping_method = ?,
                 updated_at = datetime('now')
             WHERE id = ?`
          )
            .bind(
              dealResult.dealId,
              dealResult.partnerId,
              dealResult.accountItemId ?? null,
              dealResult.taxCode ?? null,
              dealResult.mappingConfidence,
              dealResult.mappingMethod ?? null,
              receiptId
            )
            .run();
        } catch (dbError) {
          // non-fatal: deal was created, D1 update is best-effort
          safeLog.warn('[Gmail Poller] Failed to update receipt with deal info', {
            receiptId,
            error: dbError instanceof Error ? dbError.message : String(dbError),
          });
        }

        if (dealResult.status === 'needs_review') {
          safeLog.info('[Gmail Poller] Deal needs review', {
            receiptId,
            mappingConfidence: dealResult.mappingConfidence,
            provider: dealResult.selectionProvider,
            amountExtracted: classificationResult.amount_extracted,
          });
        } else {
          safeLog.info('[Gmail Poller] Deal created', {
            receiptId,
            dealId: dealResult.dealId,
            partnerId: dealResult.partnerId,
            mappingConfidence: dealResult.mappingConfidence,
          });
          metrics.dealsCreated += 1;
        }
      } else {
        dealStatus = 'skipped';
        safeLog.info('[Gmail Poller] Deal skipped (rate limit cap reached)', {
          receiptId,
          dealsCreated: metrics.dealsCreated,
          maxDealsPerRun: MAX_DEALS_PER_RUN,
        });
      }
    } catch (dealError) {
      dealStatus = 'failed';
      safeLog.warn('[Gmail Poller] Deal creation failed (receipt saved)', {
        receiptId,
        freeeReceiptId: freeeResult.receipt.id,
        error: dealError instanceof Error ? dealError.message : String(dealError),
      });
      // Record to DLQ for retry
      try {
        await env.DB!.prepare(
          `INSERT INTO receipt_dlq (receipt_id, error_code, error_message, source_type, message_id, attachment_id)
           VALUES (?, ?, ?, 'pdf', ?, ?)`
        ).bind(
          receiptId,
          'DEAL_CREATION_FAILED',
          dealError instanceof Error ? dealError.message : String(dealError),
          email.messageId,
          attachmentId
        ).run();
      } catch {
        // DLQ insert is best-effort
      }
    }

    await workflow.complete(String(freeeResult.receipt.id));

    // Mark this attachment as processed to avoid re-downloading it in subsequent polls.
    // Best-effort: failure here should not fail the pipeline.
    try {
      if (env.CACHE) {
        await env.CACHE.put(
          processedAttachmentKey(email.messageId, attachmentId),
          '1',
          { expirationTtl: 60 * 60 * 24 * 30 } // 30 days
        );
      }
    } catch (markError) {
      safeLog.warn('[Gmail Poller] Failed to mark attachment as processed (continuing)', {
        receiptId,
        messageId: email.messageId,
        attachmentId,
        error: markError instanceof Error ? markError.message : String(markError),
      });
    }

    // Backup to Google Drive (non-blocking)
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
      safeLog.info('[Gmail Poller] Backed up to Google Drive', {
        receiptId,
        driveFileId: driveResult.fileId,
        webViewLink: driveResult.webViewLink,
      });
    } catch (driveError) {
      // Non-critical: log but don't fail the entire process
      safeLog.warn('[Gmail Poller] Google Drive backup failed', {
        receiptId,
        error: driveError instanceof Error ? driveError.message : String(driveError),
      });
    }

    safeLog.info('[Gmail Poller] Receipt processed', {
      receiptId,
      freeeReceiptId: freeeResult.receipt.id,
      messageId: email.messageId,
      attachmentId,
      r2Key,
    });
    metrics.processed += 1;
  } catch (error) {
    metrics.failed += 1;
    const message = error instanceof Error ? error.message : String(error);
    safeLog.error('[Gmail Poller] Failed to process receipt attachment', {
      receiptId,
      messageId: email.messageId,
      attachmentId,
      error: message,
    });

    if (workflow) {
      try {
        await workflow.recordError(message, 'GMAIL_POLL_FAILED', {
          messageId: email.messageId,
          attachmentId,
        });
        await workflow.transition('failed', { reason: message });
      } catch (workflowError) {
        safeLog.warn('[Gmail Poller] Failed to record workflow error', {
          receiptId,
          error: workflowError instanceof Error ? workflowError.message : String(workflowError),
        });
      }
    }
  }
}
