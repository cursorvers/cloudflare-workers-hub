/**
 * Gmail Receipt Poller
 *
 * Poll Gmail for receipt PDFs and process through the receipt workflow:
 * - Distributed locking
 * - Gmail API polling
 * - AI classification
 * - R2 WORM storage
 * - freee registration (idempotent)
 * - D1 metadata + workflow state transitions
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
import { isFreeeIntegrationEnabled } from '../utils/freee-integration';
import { createStateMachine } from '../services/workflow-state-machine';
import { withLock } from './scheduled';
import { backupToGoogleDrive, type FreeeReceiptBackup } from '../services/google-drive-backup';
import { maybeExtractPdfTextForClassification } from '../services/pdf-text-extraction';

const LOCK_KEY = 'gmail:polling';
const LOCK_TTL_SECONDS = 300;
const RETENTION_YEARS = 7;
const DEFAULT_TENANT_ID = 'default';
const MAX_RESULTS = 15;
// Rate limit safety: freee allows 300 req/hr. Each deal creation uses ~4-6 API calls:
// getAccountItems (cached), getTaxes (cached), findPartner, POST /deals, PUT /receipts/:id,
// possibly createPartner. Plus receipt uploads (~1 call each).
// Budget: 4 cron runs/hr × MAX_DEALS_PER_RUN × 6 calls + 15 uploads = must stay well under 300.
// 4 × 8 × 6 = 192 + 60 uploads = 252 (~84% utilization, safe margin for retries).
const MAX_DEALS_PER_RUN = 8;

function getReceiptBucket(env: Env): R2Bucket | null {
  return env.RECEIPTS ?? env.R2 ?? null;
}

async function hasFreeeAuthTokens(env: Env): Promise<boolean> {
  // Prefer D1 (current). Fallback to KV (legacy) if present.
  if (env.DB) {
    try {
      const row = await env.DB.prepare(
        `SELECT encrypted_refresh_token
         FROM external_oauth_tokens
         WHERE provider = 'freee'
         LIMIT 1`
      ).first() as { encrypted_refresh_token?: string | null } | null;
      if (row?.encrypted_refresh_token) return true;
    } catch {
      // ignore
    }
  }

  if (env.KV) {
    try {
      // kv-optimizer:ignore-next
      const token = await env.KV.get('freee:refresh_token');
      return Boolean(token);
    } catch {
      return false;
    }
  }

  return false;
}

function normalizeFileName(fileName: string, fallback: string): string {
  const cleaned = fileName.replace(/[\\/]/g, '_').replace(/[^a-zA-Z0-9._-]/g, '_');
  return cleaned.length > 0 ? cleaned : fallback;
}

function addYears(date: Date, years: number): string {
  const next = new Date(date);
  next.setFullYear(next.getFullYear() + years);
  return next.toISOString().slice(0, 10);
}

function toIsoDate(date: Date | undefined): string {
  if (!date || Number.isNaN(date.getTime())) {
    return new Date().toISOString().slice(0, 10);
  }
  return date.toISOString().slice(0, 10);
}

async function calculateSha256(data: ArrayBuffer | ArrayBufferView): Promise<string> {
  const bytes = data instanceof ArrayBuffer
    ? new Uint8Array(data)
    : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);

  // Ensure we hand SubtleCrypto a concrete ArrayBuffer (not SharedArrayBuffer).
  const buf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);

  const hashBuffer = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function isRateLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /429|rate limit|too many requests|quota/i.test(message);
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchReceiptEmailsWithRetry(
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

function buildIdempotencyKey(messageId: string, attachmentId: string): string {
  return `gmail:${messageId}:${attachmentId}`;
}

function processedAttachmentKey(messageId: string, attachmentId: string): string {
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

async function hasDuplicateHash(env: Env, fileHash: string): Promise<string | null> {
  const existing = await env.DB!.prepare(
    'SELECT id FROM receipts WHERE file_hash = ? LIMIT 1'
  )
    .bind(fileHash)
    .first<{ id: string }>();

  return existing?.id ?? null;
}

async function processAttachment(
  env: Env,
  bucket: R2Bucket,
  freeeClient: ReturnType<typeof createFreeeClient>,
  email: GmailReceiptEmail,
  attachment: GmailReceiptAttachment,
  metrics: { processed: number; skipped: number; failed: number },
  pdfTextMetrics: {
    attempted: number;
    extracted: number;
    failed: number;
    skipped: number;
    notAttempted: number;
    reasons: Record<string, number>;
    totalElapsedMs: number;
  }
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
  const fallbackVendor = email.from || 'Unknown';

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
      };
    }

    classificationResult = {
      ...classificationResult,
      transaction_date: classificationResult.transaction_date || fallbackDate,
      vendor_name: classificationResult.vendor_name || fallbackVendor,
      amount: Number.isFinite(classificationResult.amount)
        ? Math.round(classificationResult.amount)
        : 0,
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

    await bucket.put(r2Key, attachment.data, {
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
    // Rate limit guard: cap deal creation per run to stay within freee 300 req/hr
    let dealStatus: 'created' | 'needs_review' | 'skipped' | 'failed' = 'skipped';
    try {
      if (classificationResult.amount > 0 && metrics.dealsCreated < MAX_DEALS_PER_RUN) {
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
      } else if (classificationResult.amount <= 0) {
        dealStatus = 'skipped';
        safeLog.info('[Gmail Poller] Deal skipped (zero amount)', { receiptId });
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

export async function handleGmailReceiptPolling(env: Env): Promise<void> {
  if (!env.DB) {
    safeLog.warn('[Gmail Poller] DB not configured, skipping');
    return;
  }
  if (!env.KV) {
    safeLog.warn('[Gmail Poller] KV not configured, skipping');
    return;
  }

  const bucket = getReceiptBucket(env);
  if (!bucket) {
    safeLog.warn('[Gmail Poller] Receipt bucket not configured, skipping');
    return;
  }

  if (!env.GMAIL_CLIENT_ID || !env.GMAIL_CLIENT_SECRET || !env.GMAIL_REFRESH_TOKEN) {
    safeLog.warn('[Gmail Poller] Gmail credentials not configured, skipping');
    return;
  }

  if (!isFreeeIntegrationEnabled(env)) {
    safeLog.warn('[Gmail Poller] freee integration disabled, skipping');
    return;
  }

  if (!env.FREEE_CLIENT_ID || !env.FREEE_CLIENT_SECRET || !env.FREEE_ENCRYPTION_KEY) {
    safeLog.warn('[Gmail Poller] freee integration not configured (missing secrets), skipping');
    return;
  }

  if (!(await hasFreeeAuthTokens(env))) {
    safeLog.warn('[Gmail Poller] freee not authenticated (no tokens found), skipping');
    return;
  }

  await withLock(env.KV, LOCK_KEY, LOCK_TTL_SECONDS, async () => {
    const startTime = Date.now();
    safeLog.info('[Gmail Poller] Starting Gmail receipt polling');

    let emails: GmailReceiptEmail[] = [];
    try {
      let cacheReadFailed = false;
      emails = await fetchReceiptEmailsWithRetry(env, {
        maxResults: MAX_RESULTS,
        newerThan: '1d',
        // Avoid re-downloading already-processed attachments.
        shouldDownloadAttachment: async ({ messageId, attachmentId }) => {
          if (!env.CACHE) return true;
          try {
            const existing = await env.CACHE.get(processedAttachmentKey(messageId, attachmentId));
            return !existing;
          } catch (error) {
            // Fail-open: if KV is rate-limited or quota exceeded, download and rely on D1 idempotency.
            if (!cacheReadFailed) {
              cacheReadFailed = true;
              safeLog.warn('[Gmail Poller] CACHE read failed (will download anyway)', {
                error: error instanceof Error ? error.message : String(error),
              });
            }
            return true;
          }
        },
      });
    } catch (error) {
      safeLog.error('[Gmail Poller] Failed to fetch Gmail receipts', {
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    if (emails.length === 0) {
      safeLog.info('[Gmail Poller] No receipt emails found');
      return;
    }

    const freeeClient = createFreeeClient(env);
    const metrics = { processed: 0, skipped: 0, failed: 0, dealsCreated: 0 };
    const pdfTextMetrics = {
      attempted: 0,
      extracted: 0,
      failed: 0,
      skipped: 0,
      notAttempted: 0,
      reasons: {} as Record<string, number>,
      totalElapsedMs: 0,
    };

    for (const email of emails) {
      for (const attachment of email.attachments) {
        await processAttachment(env, bucket, freeeClient, email, attachment, metrics, pdfTextMetrics);
      }
    }

    const pdfExtractionEnabled = env.PDF_TEXT_EXTRACTION_ENABLED === 'true';

    safeLog.info('[Gmail Poller] Polling completed', {
      processed: metrics.processed,
      skipped: metrics.skipped,
      failed: metrics.failed,
      dealsCreated: metrics.dealsCreated,
      ...(pdfExtractionEnabled
        ? {
            pdfTextAttempted: pdfTextMetrics.attempted,
            pdfTextExtracted: pdfTextMetrics.extracted,
            pdfTextFailed: pdfTextMetrics.failed,
            pdfTextSkipped: pdfTextMetrics.skipped,
            pdfTextNotAttempted: pdfTextMetrics.notAttempted,
            pdfTextTotalElapsedMs: pdfTextMetrics.totalElapsedMs,
            pdfTextReasons: pdfTextMetrics.reasons,
          }
        : {}),
      durationMs: Date.now() - startTime,
    });
  });
}
