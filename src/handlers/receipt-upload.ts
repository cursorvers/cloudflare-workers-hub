/**
 * Receipt Upload API (Phase 3)
 *
 * POST /api/receipts/upload
 * - Validates multipart/form-data
 * - Stores file in R2 WORM bucket
 * - Registers receipt in freee
 * - Structured logs (success/failure)
 */

import { z } from 'zod';
import type { Env } from '../types';
import { safeLog, maskUserId } from '../utils/log-sanitizer';
import { authenticateWithAccess, mapAccessUserToInternal } from '../utils/cloudflare-access';
import { getTenantContext } from '../utils/tenant-isolation';
import { verifyAPIKey } from '../utils/api-auth';
import { createFreeeClient, ApiError } from '../services/freee-client';
import { createStateMachine } from '../services/workflow-state-machine';
import { createDealFromReceipt } from '../services/freee-deal-service';
import type { ReceiptInput } from '../services/freee-deal-service';
import { isFreeeIntegrationEnabled } from '../utils/freee-integration';

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;
const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/heic',
  'image/heif',
]);

const UploadMetadataSchema = z.object({
  transaction_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  vendor_name: z.string().min(1).max(255),
  amount: z.coerce.number().int().nonnegative(),
  currency: z.string().min(1).default('JPY'),
  document_type: z.enum(['invoice', 'receipt', 'expense_report', 'other']),
});

type UploadMetadata = z.infer<typeof UploadMetadataSchema>;

interface AuthContext {
  authenticated: boolean;
  userId?: string;
  role?: string;
  tenantId?: string;
}

function jsonResponse(payload: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: JSON_HEADERS });
}

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
      // ignore (fail-open to KV check below)
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

async function calculateSha256(buffer: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function extractString(formValue: FormDataEntryValue | null): string | undefined {
  if (typeof formValue === 'string') return formValue.trim();
  return undefined;
}

function validateFile(file: File): string | null {
  if (!ALLOWED_MIME_TYPES.has(file.type)) {
    return 'Unsupported file type';
  }
  if (file.size > MAX_FILE_SIZE_BYTES) {
    return 'File size exceeds 10MB limit';
  }
  return null;
}

async function authenticateReceiptUpload(
  request: Request,
  env: Env
): Promise<AuthContext> {
  const accessResult = await authenticateWithAccess(request, env);
  if (accessResult.verified && accessResult.email) {
    const internalUser = await mapAccessUserToInternal(accessResult.email, env);
    if (internalUser) {
      const tenantContext = await getTenantContext(internalUser.userId, env);
      return {
        authenticated: true,
        userId: internalUser.userId,
        role: internalUser.role,
        tenantId: tenantContext?.tenantId ?? 'default',
      };
    }
  }

  // Support both `X-API-Key` and `Authorization: Bearer <key>` for compatibility
  // with existing scripts/clients (including the Chrome extension).
  if (verifyAPIKey(request, env, 'receipts')) {
    return {
      authenticated: true,
      userId: 'system',
      role: 'service',
      tenantId: 'default',
    };
  }

  return { authenticated: false };
}

export async function handleReceiptUpload(
  request: Request,
  env: Env
): Promise<Response> {
  const startTime = Date.now();
  const contentType = request.headers.get('Content-Type') || '';
  const freeeEnabled = isFreeeIntegrationEnabled(env);
  const freeeSecretsConfigured = Boolean(
    freeeEnabled &&
      env.FREEE_CLIENT_ID &&
      env.FREEE_CLIENT_SECRET &&
      env.FREEE_ENCRYPTION_KEY
  );

  if (!env.DB) {
    return jsonResponse({ error: 'Database not configured' }, 500);
  }

  const bucket = getReceiptBucket(env);
  if (!bucket) {
    return jsonResponse({ error: 'Receipt storage not configured' }, 500);
  }

  const auth = await authenticateReceiptUpload(request, env);
  if (!auth.authenticated) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  if (!contentType.includes('multipart/form-data')) {
    return jsonResponse({ error: 'Content-Type must be multipart/form-data' }, 415);
  }

  // Note: freee integration is optional. If it is not configured, the handler will
  // still store the file in R2 WORM and register the receipt in D1, then return success.

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch (error) {
    safeLog.warn('[Receipts] Failed to parse form data', {
      error: error instanceof Error ? error.message : String(error),
    });
    return jsonResponse({ error: 'Invalid form data' }, 400);
  }

  const fileEntry = formData.get('file');
  if (!(fileEntry instanceof File)) {
    return jsonResponse({ error: 'File is required' }, 400);
  }

  const fileValidationError = validateFile(fileEntry);
  if (fileValidationError) {
    return jsonResponse({ error: fileValidationError }, 400);
  }

  const metadataParse = UploadMetadataSchema.safeParse({
    transaction_date: extractString(formData.get('transaction_date')),
    vendor_name: extractString(formData.get('vendor_name')),
    amount: extractString(formData.get('amount')),
    currency: extractString(formData.get('currency')) || 'JPY',
    document_type: extractString(formData.get('document_type')),
  });

  if (!metadataParse.success) {
    return jsonResponse({ error: 'Invalid metadata' }, 400);
  }

  const metadata = metadataParse.data as UploadMetadata;
  const receiptId = crypto.randomUUID().replace(/-/g, '');
  const retentionUntil = addYears(new Date(), 7);
  const userId = auth.userId ?? 'unknown';
  const tenantId = auth.tenantId ?? 'default';
  const safeFileName = normalizeFileName(fileEntry.name || 'receipt', `${receiptId}.bin`);
  const r2Key = `receipts/${tenantId}/${receiptId}/${safeFileName}`;
  let workflow = createStateMachine(env, receiptId);

  try {
    const fileBuffer = await fileEntry.arrayBuffer();
    const fileHash = await calculateSha256(fileBuffer);

    const duplicate = await env.DB.prepare(
      'SELECT id FROM receipts WHERE file_hash = ? LIMIT 1'
    )
      .bind(fileHash)
      .first<{ id: string }>();

    if (duplicate?.id) {
      safeLog.warn('[Receipts] Duplicate receipt upload blocked', {
        receiptId: duplicate.id,
        tenantId,
        userId: maskUserId(userId),
      });
      return jsonResponse({ error: 'Duplicate receipt detected' }, 409);
    }

    await env.DB.prepare(
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
        metadata.transaction_date,
        metadata.vendor_name,
        metadata.amount,
        metadata.currency,
        metadata.document_type,
        'manual',
        1,
        'pending_validation',
        retentionUntil,
        tenantId
      )
      .run();

    await workflow.transition('validated', {
      userId,
      source: 'manual_upload',
    });
    await workflow.transition('classified', {
      method: 'manual',
      confidence: 1,
    });
    await workflow.transition('extracting', {
      note: 'manual upload - extraction skipped',
    });
    await workflow.transition('extracted', {
      note: 'manual upload - extraction skipped',
    });
    await workflow.transition('uploading_r2', { r2Key });

    await bucket.put(r2Key, fileBuffer, {
      httpMetadata: {
        contentType: fileEntry.type,
      },
      customMetadata: {
        fileHash,
        originalName: safeFileName,
        uploadedBy: userId,
        tenantId,
        retentionUntil,
        worm: 'true',
      },
      onlyIf: { etagDoesNotMatch: '*' },
    });

    await workflow.transition('uploaded_r2', {
      r2Key,
      size: fileEntry.size,
    });

    if (!freeeEnabled) {
      safeLog.warn('[Receipts] freee integration disabled; stored in R2 only', {
        receiptId,
        r2Key,
        tenantId,
        userId: maskUserId(userId),
        durationMs: Date.now() - startTime,
      });

      return jsonResponse({
        success: true,
        receipt_id: receiptId,
        r2_object_key: r2Key,
        freee_status: 'skipped_not_configured',
        freee_status_detail: 'disabled_by_flag',
      });
    }

    if (!freeeSecretsConfigured) {
      safeLog.warn('[Receipts] freee integration not configured (missing secrets); stored in R2 only', {
        receiptId,
        r2Key,
        tenantId,
        userId: maskUserId(userId),
        durationMs: Date.now() - startTime,
      });

      return jsonResponse({
        success: true,
        receipt_id: receiptId,
        r2_object_key: r2Key,
        freee_status: 'skipped_not_configured',
      });
    }

    const freeeAuthenticated = await hasFreeeAuthTokens(env);
    if (!freeeAuthenticated) {
      safeLog.warn('[Receipts] freee secrets configured but not authenticated; stored in R2 only', {
        receiptId,
        r2Key,
        tenantId,
        userId: maskUserId(userId),
        durationMs: Date.now() - startTime,
      });

      return jsonResponse({
        success: true,
        receipt_id: receiptId,
        r2_object_key: r2Key,
        freee_status: 'skipped_not_authenticated',
      });
    }

    try {
      await workflow.transition('submitting_freee', { fileName: safeFileName });

      const freeeClient = createFreeeClient(env);
      const freeeResult = await freeeClient.uploadReceipt(
        fileEntry,
        safeFileName,
        fileHash
      );

      // Transition to freee_uploaded (File Box upload complete)
      await workflow.transition('freee_uploaded', {
        freeeReceiptId: freeeResult.receipt.id,
      });

      // Persist freee_receipt_id to receipts table for deal linking
      await env.DB.prepare(
        "UPDATE receipts SET freee_receipt_id = ?, updated_at = datetime('now') WHERE id = ?"
      )
        .bind(String(freeeResult.receipt.id), receiptId)
        .run();

      // === Deal Automation (Phase 5) ===
      // Skip deal creation for 0-amount receipts (evidence-only)
      if (metadata.amount === 0) {
        await workflow.complete(String(freeeResult.receipt.id));

        safeLog.info('[Receipts] Upload completed (evidence-only, amount=0)', {
          receiptId,
          freeeReceiptId: freeeResult.receipt.id,
          r2Key,
          tenantId,
          userId: maskUserId(userId),
          durationMs: Date.now() - startTime,
        });

        return jsonResponse({
          success: true,
          receipt_id: receiptId,
          freee_receipt_id: freeeResult.receipt.id,
          r2_object_key: r2Key,
          deal_status: 'skipped_zero_amount',
        });
      }

      // Attempt automatic deal creation
      const receiptInput: ReceiptInput = {
        id: receiptId,
        freee_receipt_id: freeeResult.receipt.id,
        file_hash: fileHash,
        vendor_name: metadata.vendor_name,
        amount: metadata.amount,
        transaction_date: metadata.transaction_date,
        account_category: extractString(formData.get('account_category')) ?? null,
        classification_confidence: 1, // Manual upload = full confidence
        tenant_id: tenantId,
      };

      try {
        const dealResult = await createDealFromReceipt(env, receiptInput);

        if (dealResult.status === 'needs_review') {
          // Low confidence - needs manual review
          await workflow.transition('needs_review', {
            reason: 'Low account mapping confidence',
            confidence: dealResult.mappingConfidence,
          });

          // Persist suggested mapping fields for audit/review UI (even when we don't create a deal).
          try {
            await env.DB.prepare(
              `UPDATE receipts
               SET account_item_id = ?, tax_code = ?,
                   account_mapping_confidence = ?, account_mapping_method = ?,
                   updated_at = datetime('now')
               WHERE id = ?`
            )
              .bind(
                dealResult.accountItemId ?? null,
                dealResult.taxCode ?? null,
                dealResult.mappingConfidence ?? null,
                dealResult.mappingMethod ?? null,
                receiptId
              )
              .run();
          } catch {
            // non-fatal
          }

          safeLog.info('[Receipts] Upload completed, deal needs review', {
            receiptId,
            freeeReceiptId: freeeResult.receipt.id,
            mappingConfidence: dealResult.mappingConfidence,
            tenantId,
            userId: maskUserId(userId),
            durationMs: Date.now() - startTime,
          });

          return jsonResponse({
            success: true,
            receipt_id: receiptId,
            freee_receipt_id: freeeResult.receipt.id,
            r2_object_key: r2Key,
            deal_status: 'needs_review',
            mapping_confidence: dealResult.mappingConfidence,
          });
        }

        // Deal created successfully - update receipts table
        await env.DB.prepare(
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

        await workflow.complete(String(freeeResult.receipt.id));

        safeLog.info('[Receipts] Upload and deal creation completed', {
          receiptId,
          freeeReceiptId: freeeResult.receipt.id,
          dealId: dealResult.dealId,
          partnerId: dealResult.partnerId,
          mappingConfidence: dealResult.mappingConfidence,
          r2Key,
          tenantId,
          userId: maskUserId(userId),
          durationMs: Date.now() - startTime,
        });

        return jsonResponse({
          success: true,
          receipt_id: receiptId,
          freee_receipt_id: freeeResult.receipt.id,
          freee_deal_id: dealResult.dealId,
          freee_partner_id: dealResult.partnerId,
          r2_object_key: r2Key,
          deal_status: 'created',
          mapping_confidence: dealResult.mappingConfidence,
        });
      } catch (dealError: unknown) {
        // Deal creation failed - receipt is still in File Box (safe)
        // Complete the receipt upload, log the deal error for retry
        const dealMessage = dealError instanceof Error ? dealError.message : String(dealError);

        safeLog.warn('[Receipts] Deal creation failed, receipt saved', {
          receiptId,
          freeeReceiptId: freeeResult.receipt.id,
          dealError: dealMessage,
          tenantId,
          userId: maskUserId(userId),
        });

        try {
          await workflow.recordError(dealMessage, 'DEAL_CREATION_FAILED', { receiptId });
          await workflow.transition('needs_review', {
            reason: 'Deal creation failed',
            error: dealMessage,
          });
        } catch (workflowError) {
          // Fallback: at minimum complete the receipt
          await workflow.complete(String(freeeResult.receipt.id));
        }

        return jsonResponse({
          success: true,
          receipt_id: receiptId,
          freee_receipt_id: freeeResult.receipt.id,
          r2_object_key: r2Key,
          deal_status: 'failed',
          deal_error: dealMessage,
        });
      }
    } catch (freeeError: unknown) {
      // Fail-open: the receipt is already stored durably in R2+D1.
      const freeeMessage = freeeError instanceof Error ? freeeError.message : String(freeeError);
      safeLog.warn('[Receipts] freee upload failed (receipt stored)', {
        receiptId,
        r2Key,
        tenantId,
        userId: maskUserId(userId),
        freeeError: freeeMessage,
        durationMs: Date.now() - startTime,
      });
      try {
        await workflow.recordError(freeeMessage, 'FREEE_UPLOAD_FAILED', { receiptId });
        await workflow.transition('failed', { reason: 'freee upload failed' });
      } catch {
        // ignore
      }
      return jsonResponse({
        success: true,
        receipt_id: receiptId,
        r2_object_key: r2Key,
        freee_status: 'failed',
        freee_error: freeeMessage,
      });
    }
  } catch (error: any) {
    const message = error instanceof Error ? error.message : String(error);
    safeLog.error('[Receipts] Upload failed', {
      receiptId,
      error: message,
      tenantId,
      userId: maskUserId(userId),
    });

    try {
      await workflow.recordError(message, 'UPLOAD_FAILED', { receiptId });
      await workflow.transition('failed', { reason: 'Upload failed' });
    } catch (workflowError) {
      safeLog.warn('[Receipts] Failed to record workflow error', {
        receiptId,
        error: workflowError instanceof Error ? workflowError.message : String(workflowError),
      });
    }

    return jsonResponse({ error: 'Failed to upload receipt' }, 502);
  }
}
