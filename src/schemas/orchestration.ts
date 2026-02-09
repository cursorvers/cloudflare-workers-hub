/**
 * FUGUE Orchestration API - Zod Schemas
 *
 * This file defines request/response and database-model validation schemas for
 * orchestration runs, steps, and cost events.
 *
 * ---------------------------------------------------------------------------
 * ### 要件の理解
 * - Orchestration API に対する入出力を Zod で型安全に検証したい
 * - 既存の `src/schemas/notification-events.ts` と同様に:
 *   - `export const ...Schema` と `export type ... = z.infer<typeof ...Schema>` を併記
 *   - 値の制約(例: UUID, int, nonnegative, default)を Zod 側で表現
 * - 追加で、設計として複数案とトレードオフを提示し、スケーラビリティ/保守性も考慮する
 *
 * ```mermaid
 * flowchart LR
 *   Client[API Client] --> API[Orchestration API]
 *   API --> Run[(Run)]
 *   API --> Step[(Step)]
 *   API --> Cost[(CostEvent)]
 *   Step --> Provider[(LLM Provider)]
 *   Provider --> Cost
 *   API --> Client
 * ```
 *
 * ---------------------------------------------------------------------------
 * ### 設計案（複数）
 * 案A: 単一ファイル集中(本ファイル)
 * - すべての schema/type を 1 ファイルに集約
 * - メリット: 探しやすい、API境界が明確
 * - デメリット: 成長すると肥大化しやすい
 *
 * 案B: ドメイン分割
 * - `runs.ts`, `steps.ts`, `cost-events.ts`, `requests.ts` に分割して index で再export
 * - メリット: 変更影響が局所化、保守性向上
 * - デメリット: 参照関係が増え、探索コストが上がる
 *
 * 案C: バージョニング前提
 * - `orchestration.v1.ts` のように API バージョン単位で分割
 * - メリット: 後方互換の運用がしやすい
 * - デメリット: 重複が増える、移行コスト
 *
 * ---------------------------------------------------------------------------
 * ### 比較表
 * | 観点 | 案A | 案B | 案C |
 * | --- | --- | --- | --- |
 * | 保守性 | 中 | 高 | 中 |
 * | スケール(仕様追加) | 低〜中 | 高 | 高 |
 * | 変更の局所性 | 低 | 高 | 中 |
 * | 初期の実装/運用コスト | 低 | 中 | 中〜高 |
 *
 * ---------------------------------------------------------------------------
 * ### 推奨案と理由
 * - 現時点は案Aを推奨。
 * - 理由: schema 追加直後は変化が多く、分割よりも「1箇所に揃っている」ことが速度と可観測性に効く。
 * - 将来: schema が肥大化し始めたタイミングで案Bへ移行し、必要なら案Cでバージョニング。
 *
 * ---------------------------------------------------------------------------
 * ### 次のステップ
 * - APIハンドラ側で `validateRequestBody` と組み合わせ、Create/Resume/Approval などの入力検証に適用
 * - 返却レスポンス(一覧/詳細)での `safeParse` を導入し、DB/外部依存の変形に強くする
 */

import { z } from 'zod';

// =============================================================================
// Enums
// =============================================================================

export const RunStatusSchema = z.enum([
  'pending',
  'running',
  'succeeded',
  'failed',
  'blocked_error',
  'cancelled',
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const StepStatusSchema = z.enum([
  'pending',
  'running',
  'succeeded',
  'failed',
  'blocked',
  'skipped',
]);
export type StepStatus = z.infer<typeof StepStatusSchema>;

export const AgentTypeSchema = z.enum([
  'sonnet',
  'haiku',
  'opus',
  'codex',
  'glm',
  'gemini',
]);
export type AgentType = z.infer<typeof AgentTypeSchema>;

// =============================================================================
// Core Models
// =============================================================================

/**
 * Run record (database model / API model)
 */
export const RunSchema = z.object({
  run_id: z.string().uuid(),
  owner_id: z.string().min(1),
  instruction: z.string().min(1).max(10000),
  status: RunStatusSchema,
  budget_usd: z.number().min(1).max(100),
  cost_usd: z.number().nonnegative(),
  // "memory_json(parsed)" - allow any JSON-like shape (object/array/scalar) after parsing.
  memory_json: z.unknown(),
  step_count: z.number().int().nonnegative(),
  max_steps: z.number().int().min(1).max(50),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});
export type Run = z.infer<typeof RunSchema>;

/**
 * Step record (database model / API model)
 */
export const StepSchema = z.object({
  step_id: z.string().uuid(),
  run_id: z.string().uuid(),
  seq: z.number().int().positive(),
  status: StepStatusSchema,
  agent: AgentTypeSchema,
  input_ref: z.string().min(1).optional(),
  output_ref: z.string().min(1).optional(),
  attempts: z.number().int().nonnegative(),
  max_attempts: z.number().int().positive().default(3),
  idempotency_key: z.string().min(1).optional(),
  cost_usd: z.number().nonnegative(),
  started_at: z.string().datetime().optional(),
  completed_at: z.string().datetime().optional(),
  created_at: z.string().datetime(),
});
export type Step = z.infer<typeof StepSchema>;

/**
 * Cost event record (database model / API model)
 */
export const CostEventSchema = z.object({
  id: z.number().int(),
  run_id: z.string().uuid(),
  step_id: z.string().uuid().optional(),
  provider: z.string().min(1),
  model: z.string().min(1),
  tokens_in: z.number().int().nonnegative(),
  tokens_out: z.number().int().nonnegative(),
  usd: z.number().nonnegative(),
  created_at: z.string().datetime(),
});
export type CostEvent = z.infer<typeof CostEventSchema>;

// =============================================================================
// Requests / Responses
// =============================================================================

export const CreateRunRequestSchema = z.object({
  instruction: z.string().min(1).max(10000),
  budget_usd: z.number().min(1).max(100).default(10),
  max_steps: z.number().int().min(1).max(50).default(20),
});
export type CreateRunRequest = z.infer<typeof CreateRunRequestSchema>;

export const RunResponseSchema = RunSchema.extend({
  steps: z.array(StepSchema),
});
export type RunResponse = z.infer<typeof RunResponseSchema>;

export const RunListResponseSchema = z.object({
  runs: z.array(RunSchema),
  total: z.number().int(),
  page: z.number().int(),
});
export type RunListResponse = z.infer<typeof RunListResponseSchema>;

export const ResumeRunRequestSchema = z.object({
  step_id: z.string().uuid().optional(),
  override_instruction: z.string().min(1).max(10000).optional(),
});
export type ResumeRunRequest = z.infer<typeof ResumeRunRequestSchema>;

export const ApprovalDecisionSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  reason: z.string().min(1).max(10000).optional(),
});
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

