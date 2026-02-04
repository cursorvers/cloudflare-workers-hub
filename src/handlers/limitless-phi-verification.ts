/**
 * Limitless PHI Verification API Handler (Phase 6.2)
 *
 * Provides AI Gateway-powered batch verification for low-confidence PHI detections.
 * Uses Claude Haiku via Workers AI for cost-efficient verification.
 */

import { Env } from '../types';
import { safeLog } from '../utils/log-sanitizer';
import { checkRateLimit, createRateLimitResponse } from '../utils/rate-limiter';
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
  // Verify API key
  const apiKey = extractAPIKey(request);
  if (!apiKey || !verifyAPIKey(apiKey, env)) {
    return new Response(
      JSON.stringify({ success: false, error: 'Unauthorized' }),
      {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  // Rate limit check
  const rateLimitResult = await checkRateLimit(
    request,
    env,
    apiKey.substring(0, 8)
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
 * Handle batch PHI verification
 */
async function handleVerifyPhiBatch(
  request: Request,
  env: Env
): Promise<Response> {
  // Parse and validate request body
  let body: unknown;
  try {
    body = await request.json();
  } catch (error) {
    body = {}; // Use defaults
  }

  const validation = VerifyPhiBatchRequestSchema.safeParse(body);
  if (!validation.success) {
    return new Response(
      JSON.stringify({
        success: false,
        error: 'Validation failed',
        details: validation.error.errors,
      }),
      {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  const params = validation.data;

  // Create Supabase config
  const supabaseConfig: SupabaseConfig = {
    url: env.SUPABASE_URL,
    serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
  };

  try {
    // Fetch highlights that need AI verification
    const { data: highlights, error: fetchError } = await supabaseSelect<{
      id: string;
      extracted_text: string;
      phi_confidence_score: number;
    }>(
      supabaseConfig,
      'lifelog_highlights',
      `select=id,extracted_text,phi_confidence_score&needs_ai_verification=eq.true&order=highlight_time.desc&limit=${params.max_items}`
    );

    if (fetchError) {
      safeLog.error('[PHI Verification] Failed to fetch highlights', {
        error: fetchError.message,
      });

      return new Response(
        JSON.stringify({
          success: false,
          error: 'Failed to fetch highlights',
          details: fetchError.message,
        }),
        {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    if (!highlights || highlights.length === 0) {
      safeLog.info('[PHI Verification] No highlights pending verification');

      return new Response(
        JSON.stringify({
          success: true,
          data: {
            processed: 0,
            verified: 0,
            failed: 0,
            next_batch_available: false,
          },
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    // Process each highlight with AI verification
    let verified = 0;
    let failed = 0;

    for (const highlight of highlights) {
      try {
        // Call AI Gateway for verification
        const aiResult = await verifyWithAi(
          env,
          highlight.extracted_text || '',
          highlight.phi_confidence_score || 0
        );

        // Update highlight with AI verification result
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
      if (highlights.indexOf(highlight) < highlights.length - 1) {
        await sleep(1000);
      }
    }

    // Check if more batches are available
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

    return new Response(
      JSON.stringify({
        success: true,
        data: {
          processed: highlights.length,
          verified,
          failed,
          next_batch_available: nextBatchAvailable,
        },
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    safeLog.error('[PHI Verification] Unexpected error', {
      error: String(error),
    });

    return new Response(
      JSON.stringify({
        success: false,
        error: 'Internal server error',
        details: String(error),
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
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
  const response = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
    prompt,
    max_tokens: 200,
  });

  // Parse AI response
  try {
    const result = JSON.parse(response.response || '{}');
    return {
      contains_phi: result.contains_phi || false,
      confidence: result.confidence || 0,
      reasoning: result.reasoning || 'No reasoning provided',
    };
  } catch (error) {
    // Fallback: parse text response
    const containsPhi = /contains_phi.*true/i.test(response.response || '');
    const confidenceMatch = /confidence.*?(\d+)/i.exec(response.response || '');
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

/**
 * Extract API key from request headers
 */
function extractAPIKey(request: Request): string | null {
  const authHeader = request.headers.get('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.substring(7);
  }

  const apiKeyHeader = request.headers.get('X-API-Key');
  if (apiKeyHeader) {
    return apiKeyHeader;
  }

  return null;
}

/**
 * Verify API key
 */
function verifyAPIKey(apiKey: string, env: Env): boolean {
  // Check against MONITORING_API_KEY
  if (env.MONITORING_API_KEY && apiKey === env.MONITORING_API_KEY) {
    return true;
  }

  // Check against ADMIN_API_KEY
  if (env.ADMIN_API_KEY && apiKey === env.ADMIN_API_KEY) {
    return true;
  }

  // Check against legacy ASSISTANT_API_KEY
  if (env.ASSISTANT_API_KEY && apiKey === env.ASSISTANT_API_KEY) {
    return true;
  }

  return false;
}
