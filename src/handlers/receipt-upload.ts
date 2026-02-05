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
import { createFreeeClient } from '../services/freee-client';
import { createStateMachine } from '../services/workflow-state-machine';

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

  const apiKey = request.headers.get('X-API-Key');
  if (apiKey && env.RECEIPTS_API_KEY && apiKey === env.RECEIPTS_API_KEY) {
    return {
      authenticated: true,
      userId: 'system',
      role: 'service',
      tenantId: 'default',
    };
  }

  if (apiKey && env.ASSISTANT_API_KEY && apiKey === env.ASSISTANT_API_KEY) {
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

  if (
    !env.KV ||
    !env.FREEE_CLIENT_ID ||
    !env.FREEE_CLIENT_SECRET ||
    !env.FREEE_COMPANY_ID ||
    !env.FREEE_REDIRECT_URI ||
    !env.FREEE_ENCRYPTION_KEY
  ) {
    return jsonResponse({ error: 'freee integration not configured' }, 500);
  }

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

    await workflow.transition('submitting_freee', { fileName: safeFileName });

    const freeeClient = createFreeeClient(env);
    const freeeResult = await freeeClient.uploadReceipt(
      fileEntry,
      safeFileName,
      fileHash
    );

    await workflow.complete(String(freeeResult.receipt.id));

    safeLog.info('[Receipts] Upload completed', {
      receiptId,
      freeeReceiptId: freeeResult.receipt.id,
      r2Key,
      tenantId,
      userId: maskUserId(userId),
      size: fileEntry.size,
      durationMs: Date.now() - startTime,
    });

    return jsonResponse({
      success: true,
      receipt_id: receiptId,
      freee_receipt_id: freeeResult.receipt.id,
      r2_object_key: r2Key,
    });
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
