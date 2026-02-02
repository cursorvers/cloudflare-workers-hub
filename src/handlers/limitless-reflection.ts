/**
 * Limitless Reflection API Handler (Phase 5)
 *
 * Provides endpoints for collaborative reflection workflow:
 * - POST /api/limitless/reflection - Create new reflection
 * - GET /api/limitless/pending-reviews - Get pending highlights for review
 * - PATCH /api/limitless/reflection/:id - Update existing reflection
 */

import { Env } from '../types';
import { safeLog, maskUserId } from '../utils/log-sanitizer';
import { checkRateLimit, createRateLimitResponse } from '../utils/rate-limiter';
import { detectPHI } from '../services/phi-detector';
import {
  CreateReflectionRequestSchema,
  UpdateReflectionRequestSchema,
  GetPendingReviewsRequestSchema,
  validatePHIConsistency,
  type UserReflection,
  type ReflectionWithHighlight,
  type PendingReviewsResponse,
} from '../schemas/user-reflections';
import { createClient } from '@supabase/supabase-js';

/**
 * Handle Limitless Reflection API requests
 */
export async function handleLimitlessReflectionAPI(
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
    env,
    'limitless-reflection',
    apiKey.substring(0, 8)
  );
  if (!rateLimitResult.allowed) {
    return createRateLimitResponse(rateLimitResult);
  }

  // POST /api/limitless/reflection - Create reflection
  if (path === '/api/limitless/reflection' && request.method === 'POST') {
    return handleCreateReflection(request, env);
  }

  // GET /api/limitless/pending-reviews - Get pending reviews
  if (path === '/api/limitless/pending-reviews' && request.method === 'GET') {
    return handleGetPendingReviews(request, env);
  }

  // PATCH /api/limitless/reflection/:id - Update reflection
  if (path.startsWith('/api/limitless/reflection/') && request.method === 'PATCH') {
    const id = path.split('/').pop();
    if (!id) {
      return new Response(
        JSON.stringify({ success: false, error: 'Missing reflection ID' }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }
    return handleUpdateReflection(request, env, id);
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
 * Handle create reflection (POST /api/limitless/reflection)
 */
async function handleCreateReflection(
  request: Request,
  env: Env
): Promise<Response> {
  // Parse and validate request body
  let body: unknown;
  try {
    body = await request.json();
  } catch (error) {
    return new Response(
      JSON.stringify({
        success: false,
        error: 'Invalid JSON in request body',
      }),
      {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  // Validate request body
  const validation = CreateReflectionRequestSchema.safeParse(body);
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

  const reflectionData = validation.data;

  // Detect PHI in reflection text
  const phiDetectionResult = detectPHI(reflectionData.reflection_text);

  safeLog.info('[Reflection API] Creating reflection', {
    highlight_id: reflectionData.highlight_id,
    contains_phi: phiDetectionResult.contains_phi,
    detected_patterns: phiDetectionResult.detected_patterns.length,
  });

  // Create Supabase client
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

  try {
    // Insert reflection with PHI detection results
    const { data, error } = await supabase
      .from('user_reflections')
      .insert({
        highlight_id: reflectionData.highlight_id,
        user_id: env.LIMITLESS_USER_ID || 'default_user',
        reflection_text: reflectionData.reflection_text,
        key_insights: reflectionData.key_insights || [],
        action_items: reflectionData.action_items || [],
        contains_phi: phiDetectionResult.contains_phi,
        phi_approved: false, // Must be explicitly approved later
        is_public: reflectionData.is_public && !phiDetectionResult.contains_phi, // Cannot be public if contains PHI
      })
      .select()
      .single();

    if (error) {
      safeLog.error('[Reflection API] Failed to create reflection', {
        error: error.message,
      });

      return new Response(
        JSON.stringify({
          success: false,
          error: 'Failed to create reflection',
          details: error.message,
        }),
        {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    // Update highlight status to 'under_review'
    await supabase
      .from('lifelog_highlights')
      .update({
        status: 'under_review',
        reviewed_at: new Date().toISOString(),
      })
      .eq('id', reflectionData.highlight_id);

    safeLog.info('[Reflection API] Reflection created successfully', {
      id: data.id,
      contains_phi: data.contains_phi,
    });

    return new Response(
      JSON.stringify({
        success: true,
        data: {
          ...data,
          phi_detection: phiDetectionResult.contains_phi
            ? {
                detected_patterns: phiDetectionResult.detected_patterns.map(
                  (p) => ({ type: p.type, confidence: p.confidence })
                ),
                requires_approval: true,
              }
            : undefined,
        },
      }),
      {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    safeLog.error('[Reflection API] Unexpected error', {
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
 * Handle get pending reviews (GET /api/limitless/pending-reviews)
 */
async function handleGetPendingReviews(
  request: Request,
  env: Env
): Promise<Response> {
  // Parse query parameters
  const url = new URL(request.url);
  const limit = parseInt(url.searchParams.get('limit') || '20');
  const offset = parseInt(url.searchParams.get('offset') || '0');
  const status = url.searchParams.get('status') || 'pending_review';
  const notifiedOnly = url.searchParams.get('notified_only') === 'true';

  // Validate parameters
  const validation = GetPendingReviewsRequestSchema.safeParse({
    limit,
    offset,
    status,
    notified_only: notifiedOnly,
  });

  if (!validation.success) {
    return new Response(
      JSON.stringify({
        success: false,
        error: 'Invalid parameters',
        details: validation.error.errors,
      }),
      {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  const params = validation.data;

  // Create Supabase client
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

  try {
    // Build query
    let query = supabase
      .from('lifelog_highlights')
      .select('*', { count: 'exact' })
      .eq('status', params.status)
      .order('highlight_time', { ascending: false })
      .range(params.offset, params.offset + params.limit - 1);

    // Filter by notified status if requested
    if (params.notified_only) {
      query = query.not('notified_at', 'is', null);
    }

    const { data, error, count } = await query;

    if (error) {
      safeLog.error('[Reflection API] Failed to get pending reviews', {
        error: error.message,
      });

      return new Response(
        JSON.stringify({
          success: false,
          error: 'Failed to get pending reviews',
          details: error.message,
        }),
        {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    const response: PendingReviewsResponse = {
      highlights: data || [],
      total: count || 0,
      limit: params.limit,
      offset: params.offset,
    };

    safeLog.info('[Reflection API] Pending reviews retrieved', {
      total: count,
      returned: data?.length || 0,
    });

    return new Response(
      JSON.stringify({
        success: true,
        data: response,
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    safeLog.error('[Reflection API] Unexpected error', {
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
 * Handle update reflection (PATCH /api/limitless/reflection/:id)
 */
async function handleUpdateReflection(
  request: Request,
  env: Env,
  id: string
): Promise<Response> {
  // Validate UUID format
  const uuidRegex =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(id)) {
    return new Response(
      JSON.stringify({
        success: false,
        error: 'Invalid reflection ID format',
      }),
      {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  // Parse and validate request body
  let body: unknown;
  try {
    body = await request.json();
  } catch (error) {
    return new Response(
      JSON.stringify({
        success: false,
        error: 'Invalid JSON in request body',
      }),
      {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  // Validate request body
  const validation = UpdateReflectionRequestSchema.safeParse(body);
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

  const updateData = validation.data;

  // Create Supabase client
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

  try {
    // Get existing reflection
    const { data: existing, error: fetchError } = await supabase
      .from('user_reflections')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchError || !existing) {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Reflection not found',
        }),
        {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    // Prepare update object
    const updates: Partial<UserReflection> = {};

    if (updateData.reflection_text) {
      // Re-detect PHI if text changed
      const phiDetectionResult = detectPHI(updateData.reflection_text);
      updates.reflection_text = updateData.reflection_text;
      updates.contains_phi = phiDetectionResult.contains_phi;

      // Reset phi_approved if PHI status changed
      if (phiDetectionResult.contains_phi !== existing.contains_phi) {
        updates.phi_approved = false;
      }
    }

    if (updateData.key_insights) {
      updates.key_insights = updateData.key_insights;
    }

    if (updateData.action_items) {
      updates.action_items = updateData.action_items;
    }

    if (updateData.phi_approved !== undefined) {
      // Can only approve PHI if it contains PHI
      if (updateData.phi_approved && !existing.contains_phi && !updates.contains_phi) {
        return new Response(
          JSON.stringify({
            success: false,
            error: 'Cannot approve PHI for content without PHI',
          }),
          {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }
      updates.phi_approved = updateData.phi_approved;
    }

    if (updateData.is_public !== undefined) {
      // Validate PHI consistency
      const testReflection = { ...existing, ...updates, is_public: updateData.is_public };
      if (!validatePHIConsistency(testReflection)) {
        return new Response(
          JSON.stringify({
            success: false,
            error: 'Cannot make PHI content public without approval',
          }),
          {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }
      updates.is_public = updateData.is_public;
    }

    // Update reflection
    const { data, error } = await supabase
      .from('user_reflections')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      safeLog.error('[Reflection API] Failed to update reflection', {
        id,
        error: error.message,
      });

      return new Response(
        JSON.stringify({
          success: false,
          error: 'Failed to update reflection',
          details: error.message,
        }),
        {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    // Update highlight status to 'completed' if reflection is finalized
    if (data.is_public || data.phi_approved) {
      await supabase
        .from('lifelog_highlights')
        .update({ status: 'completed' })
        .eq('id', data.highlight_id);
    }

    safeLog.info('[Reflection API] Reflection updated successfully', {
      id: data.id,
      contains_phi: data.contains_phi,
      phi_approved: data.phi_approved,
      is_public: data.is_public,
    });

    return new Response(
      JSON.stringify({
        success: true,
        data,
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    safeLog.error('[Reflection API] Unexpected error', {
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
