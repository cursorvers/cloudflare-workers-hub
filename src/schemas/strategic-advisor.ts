/**
 * Strategic Advisor Schema
 *
 * FUGUE Strategic Advisor のデータスキーマ定義
 * 単なる監視ではなく「思考パートナー」として機能する本質的提案システム
 */

import { z } from 'zod';

// =============================================================================
// Goal (目標)
// =============================================================================

export const GoalSchema = z.object({
  id: z.string(),
  title: z.string(),
  intent: z.string(),                    // WHY - なぜこれをするのか
  successCriteria: z.array(z.string()),
  status: z.enum(['active', 'completed', 'paused']),
  priority: z.enum(['critical', 'high', 'medium', 'low']),
  linkedPlansSection: z.string().optional(),
  createdAt: z.number().optional(),
  updatedAt: z.number().optional(),
});

export type Goal = z.infer<typeof GoalSchema>;

// =============================================================================
// Decision (意思決定)
// =============================================================================

export const DecisionSchema = z.object({
  id: z.string(),
  title: z.string(),
  context: z.string(),
  chosen: z.string(),
  rationale: z.string(),                 // WHY - なぜこの選択をしたか
  madeAt: z.number(),
  reviewAt: z.number().optional(),       // いつ再評価すべきか
  sourceMemory: z.string().optional(),   // agent-memory へのリンク
});

export type Decision = z.infer<typeof DecisionSchema>;

// =============================================================================
// Risk (リスク)
// =============================================================================

export const RiskSchema = z.object({
  id: z.string(),
  title: z.string(),
  severity: z.enum(['critical', 'high', 'medium', 'low']),
  probability: z.number().min(0).max(1),
  mitigation: z.string(),
  status: z.enum(['active', 'mitigated', 'accepted']),
});

export type Risk = z.infer<typeof RiskSchema>;

// =============================================================================
// Assumption (前提条件)
// =============================================================================

export const AssumptionSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  validUntil: z.number().optional(),
  status: z.enum(['valid', 'invalid', 'uncertain']),
});

export type Assumption = z.infer<typeof AssumptionSchema>;

// =============================================================================
// VelocityMetrics (開発速度)
// =============================================================================

export const VelocityMetricsSchema = z.object({
  commitsPerDay: z.number(),
  tasksCompletedPerWeek: z.number(),
  averageTaskDuration: z.number(),       // hours
  trend: z.enum(['improving', 'stable', 'declining']),
});

export type VelocityMetrics = z.infer<typeof VelocityMetricsSchema>;

// =============================================================================
// ToolUsageMetrics (ツール使用状況)
// =============================================================================

export const ToolUsageMetricsSchema = z.object({
  totalSessions: z.number(),
  averageSessionDuration: z.number(),    // minutes
  mostUsedTools: z.array(z.string()),
  lastActiveAt: z.number(),
});

export type ToolUsageMetrics = z.infer<typeof ToolUsageMetricsSchema>;

// =============================================================================
// StrategicContext (戦略的コンテキスト - SSOT)
// =============================================================================

export const StrategicContextSchema = z.object({
  // 目標追跡
  goals: z.array(GoalSchema),
  currentPhase: z.string(),

  // 意思決定履歴
  decisions: z.array(DecisionSchema),

  // リスク管理
  risks: z.array(RiskSchema),
  assumptions: z.array(AssumptionSchema),

  // プロセス健全性
  velocity: VelocityMetricsSchema.optional(),
  toolUsage: ToolUsageMetricsSchema.optional(),

  // 最終更新
  updatedAt: z.number(),
  nextReviewAt: z.number(),
});

export type StrategicContext = z.infer<typeof StrategicContextSchema>;

// =============================================================================
// Insight (提案)
// =============================================================================

export const InsightTypeSchema = z.enum([
  'strategic',    // アーキテクチャ再考すべき
  'tactical',     // このタスクを分割しては
  'reflective',   // 先週より生産性20%向上
  'questioning',  // 本当に必要ですか？
]);

export type InsightType = z.infer<typeof InsightTypeSchema>;

export const InsightSchema = z.object({
  id: z.string(),
  type: InsightTypeSchema,
  title: z.string(),
  description: z.string(),
  rationale: z.string(),                 // なぜこの提案をするのか
  confidence: z.number().min(0).max(1),  // 0-1
  priority: z.enum(['high', 'medium', 'low']),
  actionable: z.boolean(),
  suggestedAction: z.string().optional(),
  relatedGoals: z.array(z.string()).optional(),
  createdAt: z.number(),
  expiresAt: z.number().optional(),
  dismissed: z.boolean().optional(),
});

export type Insight = z.infer<typeof InsightSchema>;

// =============================================================================
// InsightFeedback (フィードバック)
// =============================================================================

export const InsightFeedbackSchema = z.object({
  insightId: z.string(),
  action: z.enum(['accepted', 'dismissed', 'snoozed']),
  feedback: z.string().optional(),
  timestamp: z.number(),
});

export type InsightFeedback = z.infer<typeof InsightFeedbackSchema>;

// =============================================================================
// API Request/Response Schemas
// =============================================================================

export const GetInsightsRequestSchema = z.object({
  limit: z.number().min(1).max(10).default(3),
  types: z.array(InsightTypeSchema).optional(),
  includeDismissed: z.boolean().default(false),
});

export type GetInsightsRequest = z.infer<typeof GetInsightsRequestSchema>;

export const SubmitFeedbackRequestSchema = InsightFeedbackSchema;

export type SubmitFeedbackRequest = z.infer<typeof SubmitFeedbackRequestSchema>;
