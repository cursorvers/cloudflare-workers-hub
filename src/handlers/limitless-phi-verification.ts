/**
 * Limitless PHI Verification API Handler (Phase 6.2)
 *
 * Provides AI Gateway-powered batch verification for low-confidence PHI detections.
 * Uses Claude Haiku via Workers AI for cost-efficient verification.
 */

import { Env } from '../types';
import { safeLog } from '../utils/log-sanitizer';
import { checkRateLimit, createRateLimitResponse } from '../utils/rate-limiter';
import { verifyAPIKey as verifyAPIKeyShared } from '../utils/api-auth';
import { supabaseSelect, supabaseUpdate, SupabaseConfig } from '../services/supabase-client';
import { z } from 'zod';

/**
 * Request schema for batch verification
 */
const VerifyPhiBatchRequestSchema = z.object({
  max_items: z.number().int().positive().max(50).default(10),
  priority: z.enum(['low', 'high']).default('low'),
});

type VerifyPhiBatchRequest = z.infer<typeof VerifyPhiBatchRequestSchema>;

/**
 * AI verification result
 */
interface AiVerificationResult {
  contains_phi: boolean;
  confidence: number;
  reasoning: string;
}

/**
 * Handle PHI verification batch requests
 */
export async function handlePhiVerificationAPI(
  request: Request,
  env: Env,
  path: string
): Promise<Response> {
  // Verify API key using shared auth utility (constant-time comparison)
  if (!verifyAPIKeyShared(request, env, 'limitless')) {
    return new Response(
      JSON.stringify({ success: false, error: 'Unauthorized' }),
      {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  // Rate limit check (support all API key extraction methods for identifier)
  const apiKeyHeader = request.headers.get('X-API-Key') || request.headers.get('Authorization')?.slice(7) || new URL(request.url).searchParams.get('apiKey') || 'unknown';
  const rateLimitResult = await checkRateLimit(
    request,
    env,
    apiKeyHeader.substring(0, 8)
  );
  if (!rateLimitResult.allowed) {
    return createRateLimitResponse(rateLimitResult);
  }

  // POST /api/limitless/verify-phi-batch
  if (path === '/api/limitless/verify-phi-batch' && request.method === 'POST') {
    return handleVerifyPhiBatch(request, env);
  }

  // Unknown endpoint
  return new Response(
    JSON.stringify({ success: false, error: 'Not Found' }),
    {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    }
  );
}

/**
 * Batch verification result (shared between API and Cron)
 */
export interface PhiVerificationBatchResult {
  processed: number;
  verified: number;
  failed: number;
  next_batch_available: boolean;
}

/**
 * Core batch PHI verification logic (callable from both API and Cron)
 */
export async function processPhiVerificationBatch(
  env: Env,
  maxItems: number = 10
): Promise<PhiVerificationBatchResult> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    safeLog.error('[PHI Verification] Supabase not configured');
    throw new Error('Supabase not configured');
  }

  const supabaseConfig: SupabaseConfig = {
    url: env.SUPABASE_URL,
    serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
  };

  const { data: highlights, error: fetchError } = await supabaseSelect<{
    id: string;
    extracted_text: string;
    phi_confidence_score: number;
  }>(
    supabaseConfig,
    'lifelog_highlights',
    `select=id,extracted_text,phi_confidence_score&needs_ai_verification=eq.true&order=highlight_time.desc&limit=${maxItems}`
  );

  if (fetchError) {
    safeLog.error('[PHI Verification] Failed to fetch highlights', { error: fetchError.message });
    throw new Error(`Failed to fetch highlights: ${fetchError.message}`);
  }

  if (!highlights || highlights.length === 0) {
    safeLog.info('[PHI Verification] No highlights pending verification');
    return { processed: 0, verified: 0, failed: 0, next_batch_available: false };
  }

  let verified = 0;
  let failed = 0;

  for (const highlight of highlights) {
    try {
      const aiResult = await verifyWithAi(
        env,
        highlight.extracted_text || '',
        highlight.phi_confidence_score || 0
      );

      const newConfidence = Math.round(
        (highlight.phi_confidence_score || 0) * 0.3 + aiResult.confidence * 0.7
      );

      await supabaseUpdate(
        supabaseConfig,
        'lifelog_highlights',
        {
          phi_confidence_score: newConfidence,
          needs_ai_verification: false,
        },
        `id=eq.${highlight.id}`
      );

      verified++;

      safeLog.info('[PHI Verification] Verified highlight', {
        id: highlight.id,
        original_confidence: highlight.phi_confidence_score,
        ai_confidence: aiResult.confidence,
        final_confidence: newConfidence,
        contains_phi: aiResult.contains_phi,
      });
    } catch (error) {
      failed++;
      safeLog.error('[PHI Verification] Failed to verify highlight', {
        id: highlight.id,
        error: String(error),
      });
    }

    // Rate limiting: 1 request per second
    if (env.ENVIRONMENT !== 'test' && highlights.indexOf(highlight) < highlights.length - 1) {
      await sleep(1000);
    }
  }

  const { data: remainingHighlights } = await supabaseSelect(
    supabaseConfig,
    'lifelog_highlights',
    `select=id&needs_ai_verification=eq.true&limit=1`
  );

  const nextBatchAvailable = (remainingHighlights?.length || 0) > 0;

  safeLog.info('[PHI Verification] Batch processing completed', {
    processed: highlights.length,
    verified,
    failed,
    next_batch_available: nextBatchAvailable,
  });

  return {
    processed: highlights.length,
    verified,
    failed,
    next_batch_available: nextBatchAvailable,
  };
}

/**
 * Handle batch PHI verification (HTTP API wrapper)
 */
async function handleVerifyPhiBatch(
  request: Request,
  env: Env
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch (error) {
    body = {};
  }

  const validation = VerifyPhiBatchRequestSchema.safeParse(body);
  if (!validation.success) {
    return new Response(
      JSON.stringify({
        success: false,
        error: 'Validation failed',
        details: validation.error.errors,
      }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  try {
    const result = await processPhiVerificationBatch(env, validation.data.max_items);
    return new Response(
      JSON.stringify({ success: true, data: result }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    safeLog.error('[PHI Verification] Unexpected error', { error: String(error) });
    return new Response(
      JSON.stringify({ success: false, error: 'Internal server error', details: String(error) }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

/**
 * Verify PHI using AI Gateway (Claude Haiku via Workers AI)
 */
async function verifyWithAi(
  env: Env,
  text: string,
  regexConfidence: number
): Promise<AiVerificationResult> {
  // Build few-shot prompt
  const prompt = buildVerificationPrompt(text, regexConfidence);

  // Call Workers AI via AI Gateway
  const response = await env.AI.run('@cf/meta/llama-3.2-3b-instruct', {
    prompt,
    max_tokens: 200,
  });

  const responseText = typeof response === 'string'
    ? response
    : (response as { response?: string }).response ?? JSON.stringify(response);

  // Parse AI response
  try {
    const result = JSON.parse(responseText || '{}');
    return {
      contains_phi: result.contains_phi || false,
      confidence: result.confidence || 0,
      reasoning: result.reasoning || 'No reasoning provided',
    };
  } catch (error) {
    // Fallback: parse text response
    const containsPhi = /contains_phi.*true/i.test(responseText || '');
    const confidenceMatch = /confidence.*?(\d+)/i.exec(responseText || '');
    const confidence = confidenceMatch ? parseInt(confidenceMatch[1]) : 50;

    return {
      contains_phi: containsPhi,
      confidence,
      reasoning: 'Parsed from text response',
    };
  }
}

/**
 * Build few-shot verification prompt
 */
function buildVerificationPrompt(text: string, regexConfidence: number): string {
  return `You are a PHI (Protected Health Information) detector.

Context:
- Regex-based detection found potential PHI with ${regexConfidence}% confidence
- Your task: Determine if this text ACTUALLY contains PHI

Text to verify:
"${text}"

Examples of PHI vs NOT PHI:
1. "John Doe called about appointment" → PHI (name in medical context)
2. "The patient discussed wellness routines" → NOT PHI (generic, no identifiers)
3. "SSN 123-45-6789 on file" → PHI (SSN)
4. "Email test@example.com in meeting notes" → NOT PHI (business context, no medical data)
5. "Dr. Smith recommended rest" → NOT PHI (provider name only, no patient identifier)
6. "Patient Jane Doe, DOB 01/15/1980" → PHI (name + DOB in medical context)

Respond ONLY with valid JSON:
{
  "contains_phi": true or false,
  "confidence": 0-100,
  "reasoning": "brief explanation in one sentence"
}`;
}

/**
 * Sleep utility
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

