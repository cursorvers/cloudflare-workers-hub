/**
 * Receipt Upload API Handler
 *
 * Handles PDF receipt uploads from various sources (Stripe, Cloudflare, AWS, etc.)
 * Stores receipts in R2 and metadata in D1 for Electronic Bookkeeping Law compliance.
 */

import { Env } from '../types';

// ============================================================================
// Constants
// ============================================================================

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-API-Key, Authorization',
};

// ============================================================================
// Authentication
// ============================================================================

function validateApiKey(request: Request, env: Env): boolean {
  const apiKey = request.headers.get('X-API-Key') || request.headers.get('x-api-key');
  const authHeader = request.headers.get('Authorization');

  // Get token from either header
  const token = apiKey || (authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : null);

  if (!token) {
    return false;
  }

  // Accept any of: RECEIPTS_API_KEY, QUEUE_API_KEY, WORKERS_API_KEY
  const validKeys = [
    env.RECEIPTS_API_KEY,
    env.QUEUE_API_KEY,
    env.WORKERS_API_KEY,
  ].filter(Boolean);

  return validKeys.includes(token);
}

// ============================================================================
// Handler
// ============================================================================

export async function handleReceiptUpload(
  request: Request,
  env: Env
): Promise<Response> {
  // Handle CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // Validate API key
  if (!validateApiKey(request, env)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    // Parse multipart form data
    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    const source = formData.get('source') as string || 'unknown';
    const metadataStr = formData.get('metadata') as string || '{}';

    if (!file) {
      return new Response(JSON.stringify({ error: 'No file provided' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Parse metadata
    let metadata: Record<string, unknown> = {};
    try {
      metadata = JSON.parse(metadataStr);
    } catch {
      // Ignore JSON parse errors, use empty metadata
    }

    // Generate unique file key
    const timestamp = Date.now();
    const fileKey = `receipts/${source}/${timestamp}-${file.name}`;

    // Store file in R2 (if available)
    if (env.R2) {
      const arrayBuffer = await file.arrayBuffer();
      await env.R2.put(fileKey, arrayBuffer, {
        httpMetadata: {
          contentType: file.type || 'application/pdf',
        },
        customMetadata: {
          source,
          uploadedAt: new Date().toISOString(),
          ...Object.fromEntries(
            Object.entries(metadata).map(([k, v]) => [k, String(v)])
          ),
        },
      });
    } else {
      console.warn('[Receipt Upload] R2 bucket not configured, skipping storage');
    }

    // Store metadata in D1 (if available)
    if (env.DB) {
      try {
        await env.DB.prepare(`
          INSERT INTO receipt_uploads (
            file_key, source, filename, content_type, size_bytes,
            metadata, uploaded_at
          ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
        `).bind(
          fileKey,
          source,
          file.name,
          file.type || 'application/pdf',
          file.size,
          metadataStr
        ).run();
      } catch (dbError) {
        console.error('[Receipt Upload] D1 insert failed:', dbError);
        // Don't fail the request if D1 insert fails
      }
    }

    return new Response(JSON.stringify({
      success: true,
      fileKey,
      source,
      filename: file.name,
      size: file.size,
      uploadedAt: new Date().toISOString(),
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('[Receipt Upload] Error:', error);
    return new Response(JSON.stringify({
      error: 'Upload failed',
      message: error instanceof Error ? error.message : 'Unknown error',
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
}
