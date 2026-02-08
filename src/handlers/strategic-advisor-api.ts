/**
 * Strategic Advisor API Handler
 *
 * FUGUE Strategic Advisor の API エンドポイント
 *
 * SECURITY (批判的レビュー対応):
 * - 全エンドポイントに認証必須
 * - CF Access または JWT による認証
 * - Zod による実行時バリデーション
 */

import { z } from 'zod';
import type { Env } from '../types';
import {
  GetInsightsRequestSchema,
  SubmitFeedbackRequestSchema,
} from '../schemas/strategic-advisor';
import {
  getStrategicContext,
  getInsights,
  submitInsightFeedback,
  syncPlansContent,
  getInsightById,
} from '../services/strategic-context';
import { safeLog } from '../utils/log-sanitizer';
import { authenticateWithAccess, mapAccessUserToInternal } from '../utils/cloudflare-access';
import { verifyAPIKey } from '../utils/api-auth';
import { recordFeedback, getFeedbackAnalytics } from '../services/feedback-learning';
import type { InsightType } from '../schemas/strategic-advisor';

// =============================================================================
// Constants (GLM 指摘対応: マジックナンバー排除)
// =============================================================================

const DEFAULT_INSIGHTS_LIMIT = 3;
const MAX_CONTENT_SIZE = 1_000_000;

// =============================================================================
// Validation Schemas (Codex/GLM 指摘対応)
// =============================================================================

const SyncPlansRequestSchema = z.object({
  content: z.string().min(1).max(MAX_CONTENT_SIZE),
  filePath: z.string().regex(/^[a-zA-Z0-9_\-\/]+\.md$/, 'Invalid file path format'),
});

// =============================================================================
// Authentication Middleware (Codex 指摘対応: CRITICAL)
// =============================================================================

interface AuthResult {
  authenticated: boolean;
  userId?: string;
  role?: string;
  email?: string;
  error?: string;
}

async function authenticateRequest(request: Request, env: Env): Promise<AuthResult> {
  // 1. Try Cloudflare Access authentication
  const accessResult = await authenticateWithAccess(request, env);
  if (accessResult.verified && accessResult.email) {
    const internalUser = await mapAccessUserToInternal(accessResult.email, env);
    if (internalUser) {
      return {
        authenticated: true,
        userId: internalUser.userId,
        role: internalUser.role,
        email: accessResult.email,
      };
    }
  }

  // 2. Try API Key authentication (for internal services) — constant-time comparison
  if (verifyAPIKey(request, env, 'queue')) {
    return {
      authenticated: true,
      userId: 'system',
      role: 'admin',
    };
  }

  // 3. Try JWT Bearer token
  const authHeader = request.headers.get('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    // JWT validation would go here - simplified for now
    // In production, use proper JWT verification
    return {
      authenticated: false,
      error: 'JWT validation not yet implemented for this endpoint',
    };
  }

  return {
    authenticated: false,
    error: 'No valid authentication provided',
  };
}

// =============================================================================
// Helper Functions
// =============================================================================

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorResponse(message: string, status = 400): Response {
  return jsonResponse({ success: false, error: message }, status);
}

// =============================================================================
// Route Handlers
// =============================================================================

/**
 * GET /api/advisor/context
 * 現在の戦略的コンテキストを取得
 */
export async function handleGetContext(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const context = await getStrategicContext(env);
    return jsonResponse({
      success: true,
      data: context,
    });
  } catch (error) {
    safeLog.error('[AdvisorAPI] Failed to get context', {
      error: error instanceof Error ? error.message : String(error),
    });
    return errorResponse('Failed to get strategic context', 500);
  }
}

/**
 * GET /api/advisor/insights
 * 洞察を取得
 */
export async function handleGetInsights(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    // クエリパラメータを解析
    const url = new URL(request.url);
    const limitParam = url.searchParams.get('limit');
    const typesParam = url.searchParams.get('types');
    const includeDismissedParam = url.searchParams.get('includeDismissed');

    const options = {
      limit: limitParam ? parseInt(limitParam, 10) : DEFAULT_INSIGHTS_LIMIT,
      types: typesParam ? (typesParam.split(',') as Array<'strategic' | 'tactical' | 'reflective' | 'questioning'>) : undefined,
      includeDismissed: includeDismissedParam === 'true',
    };

    // バリデーション
    const parsed = GetInsightsRequestSchema.safeParse(options);
    if (!parsed.success) {
      return errorResponse(`Invalid parameters: ${parsed.error.message}`);
    }

    const insights = await getInsights(env, parsed.data);
    return jsonResponse({
      success: true,
      data: insights,
      meta: {
        count: insights.length,
        limit: parsed.data.limit,
      },
    });
  } catch (error) {
    safeLog.error('[AdvisorAPI] Failed to get insights', {
      error: error instanceof Error ? error.message : String(error),
    });
    return errorResponse('Failed to get insights', 500);
  }
}

/**
 * POST /api/advisor/insights/:id/feedback
 * 洞察にフィードバックを送信
 */
export async function handleSubmitFeedback(
  request: Request,
  env: Env,
  insightId: string,
  userId?: string
): Promise<Response> {
  try {
    const body = await request.json() as Record<string, unknown>;
    const parsed = SubmitFeedbackRequestSchema.safeParse({
      ...body,
      insightId,
      timestamp: Date.now(),
    });

    if (!parsed.success) {
      return errorResponse(`Invalid request: ${parsed.error.message}`);
    }

    // Get insight details for learning
    const insight = await getInsightById(env, insightId);

    const success = await submitInsightFeedback(
      env,
      parsed.data.insightId,
      parsed.data.action,
      parsed.data.feedback
    );

    if (!success) {
      return errorResponse('Failed to submit feedback', 500);
    }

    // Record feedback for learning (Phase 4)
    if (insight && userId) {
      await recordFeedback(env, userId, {
        insightId,
        insightType: insight.type as InsightType,
        action: parsed.data.action,
        confidence: insight.confidence,
        timestamp: Date.now(),
        // Optional fields - cast to access if present
        goalId: (insight as { goalId?: string }).goalId,
        ruleId: (insight as { ruleId?: string }).ruleId,
      });
    }

    return jsonResponse({
      success: true,
      message: 'Feedback recorded',
    });
  } catch (error) {
    safeLog.error('[AdvisorAPI] Failed to submit feedback', {
      error: error instanceof Error ? error.message : String(error),
    });
    return errorResponse('Failed to submit feedback', 500);
  }
}

/**
 * POST /api/advisor/sync
 * Plans.md の内容を同期
 *
 * SECURITY (Codex/GLM 指摘対応):
 * - Zod による実行時バリデーション
 * - パストラバーサル防止
 */
export async function handleSyncPlans(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const body = await request.json();

    // Zod バリデーション (GLM 指摘対応)
    const parsed = SyncPlansRequestSchema.safeParse(body);
    if (!parsed.success) {
      safeLog.warn('[AdvisorAPI] Sync validation failed', {
        errors: parsed.error.errors,
      });
      return errorResponse(`Validation error: ${parsed.error.errors.map(e => e.message).join(', ')}`);
    }

    // パストラバーサル防止 (Codex 指摘対応)
    if (parsed.data.filePath.includes('..')) {
      return errorResponse('Path traversal not allowed', 400);
    }

    await syncPlansContent(env, parsed.data.content, parsed.data.filePath);

    return jsonResponse({
      success: true,
      message: 'Plans.md synced',
    });
  } catch (error) {
    safeLog.error('[AdvisorAPI] Failed to sync plans', {
      error: error instanceof Error ? error.message : String(error),
    });
    return errorResponse('Failed to sync plans', 500);
  }
}

/**
 * GET /api/advisor/goals
 * アクティブなゴール一覧を取得
 */
export async function handleGetGoals(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const context = await getStrategicContext(env);
    const url = new URL(request.url);
    const statusFilter = url.searchParams.get('status');

    let goals = context.goals;
    if (statusFilter) {
      goals = goals.filter(g => g.status === statusFilter);
    }

    return jsonResponse({
      success: true,
      data: goals,
      meta: {
        total: goals.length,
        currentPhase: context.currentPhase,
      },
    });
  } catch (error) {
    safeLog.error('[AdvisorAPI] Failed to get goals', {
      error: error instanceof Error ? error.message : String(error),
    });
    return errorResponse('Failed to get goals', 500);
  }
}

/**
 * GET /api/advisor/analytics
 * フィードバック分析を取得 (Phase 4)
 */
export async function handleGetAnalytics(
  request: Request,
  env: Env,
  userId?: string
): Promise<Response> {
  try {
    if (!userId) {
      return errorResponse('User ID required for analytics', 400);
    }

    const analytics = await getFeedbackAnalytics(env, userId);

    if (!analytics) {
      return jsonResponse({
        success: true,
        data: null,
        message: 'No feedback data yet',
      });
    }

    return jsonResponse({
      success: true,
      data: analytics,
    });
  } catch (error) {
    safeLog.error('[AdvisorAPI] Failed to get analytics', {
      error: error instanceof Error ? error.message : String(error),
    });
    return errorResponse('Failed to get analytics', 500);
  }
}

// =============================================================================
// Main Router (認証必須)
// =============================================================================

export async function handleAdvisorAPI(
  request: Request,
  env: Env,
  path: string
): Promise<Response> {
  const method = request.method;

  // 認証チェック (Codex 指摘対応: CRITICAL)
  const auth = await authenticateRequest(request, env);
  if (!auth.authenticated) {
    safeLog.warn('[AdvisorAPI] Unauthorized access attempt', {
      path,
      error: auth.error,
    });
    return errorResponse(auth.error || 'Unauthorized', 401);
  }

  safeLog.log('[AdvisorAPI] Authenticated request', {
    path,
    userId: auth.userId,
    role: auth.role,
  });

  // Route matching
  if (method === 'GET' && path === '/api/advisor/context') {
    return handleGetContext(request, env);
  }

  if (method === 'GET' && path === '/api/advisor/insights') {
    return handleGetInsights(request, env);
  }

  if (method === 'GET' && path === '/api/advisor/goals') {
    return handleGetGoals(request, env);
  }

  if (method === 'POST' && path === '/api/advisor/sync') {
    return handleSyncPlans(request, env);
  }

  // Feedback endpoint with ID
  const feedbackMatch = path.match(/^\/api\/advisor\/insights\/([^/]+)\/feedback$/);
  if (method === 'POST' && feedbackMatch) {
    return handleSubmitFeedback(request, env, feedbackMatch[1], auth.userId);
  }

  // Analytics endpoint (Phase 4)
  if (method === 'GET' && path === '/api/advisor/analytics') {
    return handleGetAnalytics(request, env, auth.userId);
  }

  return errorResponse('Not found', 404);
}
