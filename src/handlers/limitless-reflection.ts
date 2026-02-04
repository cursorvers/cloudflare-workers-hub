/**
 * Limitless Reflection API Handler (Phase 5)
 *
 * Provides endpoints for collaborative reflection workflow:
 * - POST /api/limitless/reflection - Create new reflection
 * - GET /api/limitless/pending-reviews - Get pending highlights for review
 * - PATCH /api/limitless/reflection/:id - Update existing reflection
 */

import { Env } from '../types';
import { safeLog } from '../utils/log-sanitizer';
import { checkRateLimit, createRateLimitResponse } from '../utils/rate-limiter';
import { detectPHI } from '../services/phi-detector';
import {
  CreateReflectionRequestSchema,
  UpdateReflectionRequestSchema,
  validatePHIConsistency,
  type UserReflection,
} from '../schemas/user-reflections';
import {
  supabaseSelect,
  supabaseInsert,
  supabaseUpdate,
  type SupabaseConfig,
} from '../services/supabase-client';
import { sendReflectionNotification } from '../services/reflection-notifier';

/**
 * Handle Limitless Reflection API requests
 */
export async function handleLimitlessReflectionAPI(
  request: Request,
  env: Env,
  path: string
): Promise<Response> {
  // Verify API key (support header OR query parameter for iOS Shortcut)
  const apiKey = extractAPIKey(request);
  if (!apiKey || !verifyAPIKey(apiKey, env)) {
    safeLog.warn('[Reflection API] Unauthorized access attempt', {
      hasApiKey: !!apiKey,
      ip: request.headers.get('CF-Connecting-IP') || 'unknown',
    });
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

  // Detect PHI in all text fields
  const reflectionTextPHI = detectPHI(reflectionData.reflection_text);
  const insightsPHI = (reflectionData.key_insights || []).map(detectPHI);
  const actionsPHI = (reflectionData.action_items || []).map(detectPHI);

  const allDetectedPatterns = [
    ...reflectionTextPHI.detected_patterns,
    ...insightsPHI.flatMap((r) => r.detected_patterns),
    ...actionsPHI.flatMap((r) => r.detected_patterns),
  ];

  const contains_phi =
    reflectionTextPHI.contains_phi ||
    insightsPHI.some((r) => r.contains_phi) ||
    actionsPHI.some((r) => r.contains_phi);

  const needs_verification =
    reflectionTextPHI.needs_verification ||
    insightsPHI.some((r) => r.needs_verification) ||
    actionsPHI.some((r) => r.needs_verification);

  safeLog.info('[Reflection API] Creating reflection', {
    highlight_id: reflectionData.highlight_id,
    contains_phi,
    detected_patterns: allDetectedPatterns.length,
    confidence_score: reflectionTextPHI.confidence_score,
    needs_verification,
  });

  // Force manual review if needs_verification is true
  let is_public = reflectionData.is_public || false;
  if (needs_verification) {
    is_public = false; // Force private until manual approval
    safeLog.warn('[Reflection API] Forcing private due to needs_verification', {
      highlight_id: reflectionData.highlight_id,
      original_is_public: reflectionData.is_public,
    });
  }

  // PHI consistency check
  if (contains_phi && is_public) {
    safeLog.warn('[Reflection API] PHI consistency violation', {
      highlight_id: reflectionData.highlight_id,
    });
    return new Response(
      JSON.stringify({
        success: false,
        error: 'Cannot publish reflection containing PHI without approval',
      }),
      {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  // Supabase config
  const config: SupabaseConfig = {
    url: env.SUPABASE_URL!,
    serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY!,
  };

  try {
    // Insert reflection
    const insertData = {
      highlight_id: reflectionData.highlight_id,
      user_id: 'default_user', // Single-user system
      reflection_text: reflectionData.reflection_text,
      key_insights: reflectionData.key_insights || [],
      action_items: reflectionData.action_items || [],
      contains_phi,
      phi_approved: false,
      is_public, // Use computed is_public (forced to false if needs_verification)
    };

    const { data: insertedReflection, error: insertError } = await supabaseInsert<UserReflection>(
      config,
      'user_reflections',
      insertData
    );

    if (insertError) {
      safeLog.error('[Reflection API] Failed to insert reflection', {
        error: insertError.message,
      });
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Failed to create reflection',
          details: insertError.message,
        }),
        {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    // Update highlight status
    const { error: updateError } = await supabaseUpdate(
      config,
      'lifelog_highlights',
      {
        status: 'under_review',
        reviewed_at: new Date().toISOString(),
      },
      `id=eq.${reflectionData.highlight_id}`
    );

    if (updateError) {
      safeLog.warn('[Reflection API] Failed to update highlight status', {
        highlight_id: reflectionData.highlight_id,
        error: updateError.message,
      });
    }

    safeLog.info('[Reflection API] Reflection created successfully', {
      reflection_id: insertedReflection?.[0]?.id,
      highlight_id: reflectionData.highlight_id,
      contains_phi,
      needs_verification,
    });

    // Send Discord alert if needs verification
    if (needs_verification) {
      // Send alert notification (force=true to bypass frequency control)
      await sendReflectionNotification(
        env,
        'discord',
        {
          highlight_id: reflectionData.highlight_id,
          highlight_time: new Date().toISOString(), // Use current time for alert
          extracted_text: `⚠️ PHI検出: 手動レビュー必要\n\n${reflectionData.reflection_text.substring(0, 150)}...`,
          speaker_name: 'System',
          topics: ['PHI Review Required'],
          notification_url: `https://cockpit.masayuki.work/reflections/${insertedReflection?.[0]?.id}`,
        },
        true // force=true
      ).catch((error) => {
        safeLog.error('[Reflection API] Failed to send Discord alert', {
          error: String(error),
        });
      });
    }

    return new Response(
      JSON.stringify({
        success: true,
        reflection: {
          ...insertedReflection?.[0],
          detected_patterns: allDetectedPatterns,
          masked_text: reflectionTextPHI.masked_text,
          needs_verification, // Include in response
        },
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    safeLog.error('[Reflection API] Unexpected error creating reflection', {
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
  // Supabase config
  const config: SupabaseConfig = {
    url: env.SUPABASE_URL!,
    serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY!,
  };

  try {
    // Query highlights with status='pending_review' AND notified_at IS NOT NULL
    const selectFields =
      'id,highlight_time,extracted_text,speaker_name,topics,status,notified_at,created_at';
    const query = `select=${selectFields}&status=eq.pending_review&notified_at=not.is.null&order=highlight_time.desc&limit=50`;

    const { data: highlights, error } = await supabaseSelect<{
      id: string;
      highlight_time: string;
      extracted_text: string | null;
      speaker_name: string | null;
      topics: string[];
      status: string;
      notified_at: string | null;
      created_at: string;
    }>(config, 'lifelog_highlights', query);

    if (error) {
      safeLog.error('[Reflection API] Failed to fetch pending reviews', {
        error: error.message,
      });
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Failed to fetch pending reviews',
          details: error.message,
        }),
        {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    safeLog.info('[Reflection API] Fetched pending reviews', {
      count: highlights?.length || 0,
    });

    return new Response(
      JSON.stringify({
        success: true,
        highlights: highlights || [],
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    safeLog.error('[Reflection API] Unexpected error fetching pending reviews', {
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
  reflectionId: string
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

  // Supabase config
  const config: SupabaseConfig = {
    url: env.SUPABASE_URL!,
    serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY!,
  };

  try {
    // Fetch existing reflection
    const { data: existing, error: fetchError } = await supabaseSelect<UserReflection>(
      config,
      'user_reflections',
      `select=*&id=eq.${reflectionId}`
    );

    if (fetchError) {
      safeLog.error('[Reflection API] Failed to fetch reflection', {
        reflection_id: reflectionId,
        error: fetchError.message,
      });
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Failed to fetch reflection',
          details: fetchError.message,
        }),
        {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    if (!existing || existing.length === 0) {
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

    const currentReflection = existing[0];

    // Detect PHI if text fields changed
    const mergedReflection = {
      ...currentReflection,
      ...updateData,
    };

    let contains_phi = currentReflection.contains_phi;

    if (updateData.reflection_text || updateData.key_insights || updateData.action_items) {
      const reflectionTextPHI = detectPHI(
        updateData.reflection_text || currentReflection.reflection_text
      );
      const insightsPHI = (
        updateData.key_insights ||
        currentReflection.key_insights ||
        []
      ).map(detectPHI);
      const actionsPHI = (
        updateData.action_items ||
        currentReflection.action_items ||
        []
      ).map(detectPHI);

      contains_phi =
        reflectionTextPHI.contains_phi ||
        insightsPHI.some((r) => r.contains_phi) ||
        actionsPHI.some((r) => r.contains_phi);

      safeLog.info('[Reflection API] PHI re-detection after update', {
        reflection_id: reflectionId,
        contains_phi,
      });
    }

    // PHI consistency check
    const isPublic = updateData.is_public !== undefined ? updateData.is_public : currentReflection.is_public;
    const phiApproved = updateData.phi_approved !== undefined ? updateData.phi_approved : currentReflection.phi_approved;

    if (contains_phi && isPublic && !phiApproved) {
      safeLog.warn('[Reflection API] PHI consistency violation on update', {
        reflection_id: reflectionId,
      });
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Cannot publish reflection containing PHI without approval',
        }),
        {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    // Update reflection
    const finalUpdateData: Partial<UserReflection> = {
      ...updateData,
      contains_phi,
    };

    const { data: updatedReflection, error: updateError } = await supabaseUpdate<UserReflection>(
      config,
      'user_reflections',
      finalUpdateData,
      `id=eq.${reflectionId}`
    );

    if (updateError) {
      safeLog.error('[Reflection API] Failed to update reflection', {
        reflection_id: reflectionId,
        error: updateError.message,
      });
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Failed to update reflection',
          details: updateError.message,
        }),
        {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    safeLog.info('[Reflection API] Reflection updated successfully', {
      reflection_id: reflectionId,
      contains_phi,
      is_public: isPublic,
      phi_approved: phiApproved,
    });

    return new Response(
      JSON.stringify({
        success: true,
        reflection: updatedReflection?.[0] || mergedReflection,
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    safeLog.error('[Reflection API] Unexpected error updating reflection', {
      reflection_id: reflectionId,
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
 * Extract API key from request headers or query parameters
 */
function extractAPIKey(request: Request): string | null {
  // Check Authorization header
  const authHeader = request.headers.get('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.substring(7);
  }

  // Check X-API-Key header
  const apiKeyHeader = request.headers.get('X-API-Key');
  if (apiKeyHeader) {
    return apiKeyHeader;
  }

  // Check query parameter (iOS Shortcut fallback)
  const url = new URL(request.url);
  const apiKeyQuery = url.searchParams.get('apiKey');
  if (apiKeyQuery) {
    return apiKeyQuery;
  }

  return null;
}

/**
 * Verify API key against environment variables
 */
function verifyAPIKey(apiKey: string, env: Env): boolean {
  // Check against MONITORING_API_KEY (for reflection operations)
  if (env.MONITORING_API_KEY && apiKey === env.MONITORING_API_KEY) {
    return true;
  }

  // Check against HIGHLIGHT_API_KEY (for compatibility)
  if (env.HIGHLIGHT_API_KEY && apiKey === env.HIGHLIGHT_API_KEY) {
    return true;
  }

  return false;
}
