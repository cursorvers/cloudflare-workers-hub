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
} from '../services/gmail-receipt-client';
import { classifyReceipt } from '../services/ai-receipt-classifier';
import { createFreeeClient } from '../services/freee-client';
import { createStateMachine } from '../services/workflow-state-machine';
import { withLock } from './scheduled';
import { backupToGoogleDrive, type FreeeReceiptBackup } from '../services/google-drive-backup';

const LOCK_KEY = 'gmail:polling';
const LOCK_TTL_SECONDS = 300;
const RETENTION_YEARS = 7;
const DEFAULT_TENANT_ID = 'default';
const MAX_RESULTS = 15;

function getReceiptBucket(env: Env): R2Bucket | null {
  return env.RECEIPTS ?? env.R2 ?? null;
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
  const buffer = data instanceof ArrayBuffer
    ? data
    : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
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
  options: { query?: string; maxResults?: number; newerThan?: string } = {}
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

function buildClassificationText(
  email: GmailReceiptEmail,
  attachment: GmailReceiptAttachment
): string {
  return [
    `Subject: ${email.subject}`,
    `From: ${email.from}`,
    `Date: ${email.date.toISOString()}`,
    `Attachment: ${attachment.filename}`,
  ].join('\n');
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
  metrics: { processed: number; skipped: number; failed: number }
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

    let classificationResult;
    try {
      classificationResult = await classifyReceipt(
        env,
        buildClassificationText(email, attachment),
        {
          messageId: email.messageId,
          attachmentId,
          subject: email.subject,
          from: email.from,
          emailDate: email.date.toISOString(),
        }
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

    const fileBlob = new Blob([attachment.data], {
      type: attachment.mimeType || 'application/pdf',
    });
    const freeeResult = await freeeClient.uploadReceipt(
      fileBlob,
      safeFileName,
      idempotencyKey
    );

    await workflow.complete(String(freeeResult.receipt.id));

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

  if (
    !env.FREEE_CLIENT_ID ||
    !env.FREEE_CLIENT_SECRET ||
    !env.FREEE_COMPANY_ID ||
    !env.FREEE_REDIRECT_URI ||
    !env.FREEE_ENCRYPTION_KEY
  ) {
    safeLog.warn('[Gmail Poller] freee integration not configured, skipping');
    return;
  }

  await withLock(env.KV, LOCK_KEY, LOCK_TTL_SECONDS, async () => {
    const startTime = Date.now();
    safeLog.info('[Gmail Poller] Starting Gmail receipt polling');

    let emails: GmailReceiptEmail[] = [];
    try {
      emails = await fetchReceiptEmailsWithRetry(env, {
        maxResults: MAX_RESULTS,
        newerThan: '1d',
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
    const metrics = { processed: 0, skipped: 0, failed: 0 };

    for (const email of emails) {
      for (const attachment of email.attachments) {
        await processAttachment(env, bucket, freeeClient, email, attachment, metrics);
      }
    }

    safeLog.info('[Gmail Poller] Polling completed', {
      processed: metrics.processed,
      skipped: metrics.skipped,
      failed: metrics.failed,
      durationMs: Date.now() - startTime,
    });
  });
}
