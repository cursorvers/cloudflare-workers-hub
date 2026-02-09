/**
 * RunCoordinator Durable Object (FUGUE Orchestration API Day 2)
 *
 * ---------------------------------------------------------------------------
 * ### 要件の理解
 * - 1つの Orchestration Run (= 1 Durable Object instance) のライフサイクルを管理する
 * - Run 状態: 'pending' から開始し、最初の step 実行開始で 'running' へ
 * - Step は seq 順に逐次実行し、各 step は PENDING -> RUNNING -> SUCCEEDED/FAILED
 * - 失敗時は最大 3 回まで retry。max_attempts 到達で run は 'blocked_error'
 * - すべての step が成功したら run は 'succeeded'
 * - Idempotency: step 実行前に DO storage の idempotency:{key} を確認し、存在すれば cached result を返し step 実行をスキップ
 *   - idempotency_key は step 入力の hash
 * - DO Storage keys:
 *   - 'run_state' (run 全体)
 *   - 'step:{seq}' (step 状態)
 *   - 'idempotency:{key}' (cached result)
 * - Internal API (DO fetch):
 *   - POST /start
 *   - POST /step-complete
 *   - GET  /state
 *   - POST /cancel
 * - alarm(): 30s ごとに stuck step を検知 (RUNNING > 5min) -> failed + retry
 * - Budget guard: cost_usd を追跡し、budget 超過時は新しい step を拒否
 *
 * ---------------------------------------------------------------------------
 * ### 設計案（複数）
 * 案A: DO が "状態だけ" を持ち、実行は外部 executor が pull する (本実装)
 * - /start や /step-complete のレスポンスで「次に実行すべき step」を返す
 * - メリット: DO はスケールしやすく、外部実行基盤(Queue/Daemon/別Worker)の差し替えが容易
 * - デメリット: executor が polling/再試行責務を一部持つ必要がある
 *
 * 案B: DO が "状態 + 実行" まで担い、外部サービスを直接呼ぶ
 * - メリット: 単純なクライアントで完結しやすい
 * - デメリット: 外部I/Oが DO に集中し、保守/テスト/障害切り分けが難しくなりがち
 *
 * 案C: Hybrid (DO は状態 + 次stepを Queue に push し、executor は event-driven)
 * - メリット: 低レイテンシ・低ポーリング、バックプレッシャーを掛けやすい
 * - デメリット: キュー運用・DLQ・可観測性の設計が追加で必要
 *
 * ---------------------------------------------------------------------------
 * ### 図解（Mermaid）
 * ```mermaid
 * sequenceDiagram
 *   participant Exec as Executor
 *   participant DO as RunCoordinator(DO)
 *   participant STO as DO Storage
 *
 *   Exec->>DO: POST /start {steps[]}
 *   DO->>STO: get/put run_state, step:{seq}
 *   DO-->>Exec: { action: execute_step, step }
 *   Exec->>DO: POST /step-complete {seq, status, result, cost}
 *   DO->>STO: put step:{seq}, idempotency:{key}, run_state
 *   DO-->>Exec: { action: execute_step | run_done | run_blocked }
 * ```
 *
 * ---------------------------------------------------------------------------
 * ### 非機能要件（スケーラビリティ、保守性）
 * - スケーラビリティ:
 *   - Run 単位で DO がシャーディングされ、同時 Run 数に比例して水平分散
 *   - 逐次実行により同一 Run 内の競合を抑制 (DO のシリアライズ特性と整合)
 * - 保守性:
 *   - 状態遷移を一箇所(driveRun)に集約し、fetch/alarm は薄いルーティングに限定
 *   - storage key を明示し、後続の監視/移行/デバッグがしやすい構造にする
 *
 * ---------------------------------------------------------------------------
 * ### 比較表
 * | 観点 | 案A(本実装) | 案B | 案C |
 * | --- | --- | --- | --- |
 * | 運用の単純さ | 中 | 高 | 低〜中 |
 * | スケール | 高 | 中 | 高 |
 * | 障害分離 | 高 | 中 | 高 |
 * | 実装コスト | 中 | 中 | 高 |
 *
 * ---------------------------------------------------------------------------
 * ### 推奨案と理由
 * - 推奨: 案A
 * - 理由: DO は状態機械・再試行・idempotency・budget guard に集中し、実行面の変更(Queue, cron, daemon, edge worker)
 *   を後から差し替え可能にするのが長期保守に効くため。
 *
 * ---------------------------------------------------------------------------
 * ### 次のステップ
 * - 外部 executor 側で /start 返却の step を実行し /step-complete を呼ぶ実装を追加
 * - 可観測性: run_id/seq/attempt をログ・メトリクスに揃え、stuck/blocked を検知するダッシュボードを用意
 * - 予算・コスト: cost event の粒度(トークン/モデル)を取り込み、budget 超過時の UX を設計
 */

import { DurableObject } from 'cloudflare:workers';
import { z } from 'zod';
import type { Env } from '../types';
import {
  AgentTypeSchema,
  RunStatusSchema,
  StepStatusSchema,
  type AgentType,
  type RunStatus,
  type StepStatus,
} from '../schemas/orchestration';
import { safeLog } from '../utils/log-sanitizer';

// =============================================================================
// Constants
// =============================================================================

const ALARM_INTERVAL_MS = 30_000;
const STUCK_STEP_MS = 5 * 60_000;
const DEFAULT_MAX_ATTEMPTS = 3;

// =============================================================================
// Internal Types (DO state is intentionally independent from D1 models)
// =============================================================================

type ISODateTimeString = string;

interface RunState {
  run_id: string;
  status: RunStatus;
  budget_usd: number;
  cost_usd: number;
  step_count: number;
  current_seq?: number; // currently running (best-effort)
  blocked_reason?: string;
  cancelled_reason?: string;
  created_at: ISODateTimeString;
  updated_at: ISODateTimeString;
}

interface StepState {
  seq: number;
  status: StepStatus;
  agent: AgentType;
  attempts: number;
  max_attempts: number;
  idempotency_key: string; // input hash
  input: unknown;
  result?: unknown;
  error?: string;
  cost_usd: number;
  started_at?: ISODateTimeString;
  completed_at?: ISODateTimeString;
  updated_at: ISODateTimeString;
}

type IdempotencyRecord = {
  key: string;
  stored_at: ISODateTimeString;
  result: unknown;
};

type IdempotencyHit = {
  seq: number;
  key: string;
  result: unknown;
};

type DriveAction =
  | { action: 'execute_step'; step: Pick<StepState, 'seq' | 'agent' | 'attempts' | 'max_attempts' | 'idempotency_key' | 'input'> }
  | { action: 'awaiting_step'; step: Pick<StepState, 'seq' | 'status' | 'started_at' | 'attempts' | 'max_attempts'> }
  | { action: 'run_done'; status: RunStatus }
  | { action: 'run_blocked'; status: RunStatus; reason?: string }
  | { action: 'run_cancelled'; status: RunStatus; reason?: string };

type DriveResult = {
  action: DriveAction;
  idempotency_hits: IdempotencyHit[];
};

// =============================================================================
// Zod Schemas (Internal API)
// =============================================================================

const StartRequestSchema = z.object({
  run_id: z.string().uuid(),
  budget_usd: z.number().nonnegative(),
  cost_usd: z.number().nonnegative().optional(),
  steps: z.array(z.object({
    seq: z.number().int().positive(),
    agent: AgentTypeSchema,
    input: z.unknown(),
    max_attempts: z.number().int().min(1).max(10).optional(),
  })).min(1),
});
type StartRequest = z.infer<typeof StartRequestSchema>;

const StepCompleteRequestSchema = z.object({
  seq: z.number().int().positive(),
  status: z.enum(['succeeded', 'failed']),
  result: z.unknown().optional(),
  error: z.string().min(1).max(20_000).optional(),
  cost_usd: z.number().nonnegative().optional(),
});
type StepCompleteRequest = z.infer<typeof StepCompleteRequestSchema>;

const CancelRequestSchema = z.object({
  reason: z.string().min(1).max(10_000).optional(),
});
type CancelRequest = z.infer<typeof CancelRequestSchema>;

// =============================================================================
// Helpers
// =============================================================================

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorResponse(message: string, status: number, code?: string): Response {
  return jsonResponse({ success: false, error: { code: code ?? 'ERROR', message } }, status);
}

function nowIso(): string {
  return new Date().toISOString();
}

function stepStorageKey(seq: number): string {
  return `step:${seq}`;
}

function idempotencyStorageKey(key: string): string {
  return `idempotency:${key}`;
}

function hexFromArrayBuffer(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

function stableNormalizeJson(value: unknown): unknown {
  if (value === null) return null;
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean') return value;
  if (Array.isArray(value)) return value.map(stableNormalizeJson);
  if (t === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const out: Record<string, unknown> = {};
    for (const k of keys) out[k] = stableNormalizeJson(obj[k]);
    return out;
  }
  // undefined / function / symbol etc. are not valid JSON; normalize to null.
  return null;
}

async function hashJson(value: unknown): Promise<string> {
  const normalized = stableNormalizeJson(value);
  const json = JSON.stringify(normalized);
  const bytes = new TextEncoder().encode(json);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return `sha256:${hexFromArrayBuffer(digest)}`;
}

// =============================================================================
// Durable Object
// =============================================================================

export class RunCoordinator extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Periodic alarm (stuck detection / retry)
    this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
  }

  /**
   * Internal HTTP API for run coordination.
   * Uses Bearer token authentication to avoid accidental public access.
   */
  async fetch(request: Request): Promise<Response> {
    // Verify internal bearer token (pattern-match with TaskCoordinator)
    const expectedKey =
      this.env.WORKERS_API_KEY ??
      this.env.ASSISTANT_API_KEY ??
      this.env.QUEUE_API_KEY;

    if (expectedKey) {
      const authHeader = request.headers.get('Authorization');
      const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
      if (token !== expectedKey) {
        return errorResponse('Unauthorized', 401, 'UNAUTHORIZED');
      }
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === '/start' && request.method === 'POST') {
        const body = await request.json().catch(() => null);
        if (!body) return errorResponse('Request body must be valid JSON', 400, 'INVALID_BODY');
        const parsed = StartRequestSchema.safeParse(body);
        if (!parsed.success) return errorResponse(parsed.error.message, 400, 'VALIDATION_ERROR');
        const res = await this.handleStart(parsed.data);
        return jsonResponse({ success: true, ...res }, 200);
      }

      if (path === '/step-complete' && request.method === 'POST') {
        const body = await request.json().catch(() => null);
        if (!body) return errorResponse('Request body must be valid JSON', 400, 'INVALID_BODY');
        const parsed = StepCompleteRequestSchema.safeParse(body);
        if (!parsed.success) return errorResponse(parsed.error.message, 400, 'VALIDATION_ERROR');
        const res = await this.handleStepComplete(parsed.data);
        return jsonResponse({ success: true, ...res }, 200);
      }

      if (path === '/state' && request.method === 'GET') {
        const state = await this.handleGetState();
        return jsonResponse({ success: true, data: state }, 200);
      }

      if (path === '/cancel' && request.method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const parsed = CancelRequestSchema.safeParse(body);
        if (!parsed.success) return errorResponse(parsed.error.message, 400, 'VALIDATION_ERROR');
        const res = await this.handleCancel(parsed.data);
        return jsonResponse({ success: true, ...res }, 200);
      }

      return errorResponse('Not found', 404, 'NOT_FOUND');
    } catch (err) {
      console.error('[RunCoordinator] Request error:', err instanceof Error ? err.message : String(err));
      return errorResponse('Internal error', 500, 'INTERNAL_ERROR');
    }
  }

  // =============================================================================
  // Handlers
  // =============================================================================

  private async handleStart(req: StartRequest): Promise<{ data: { run: RunState; action: DriveAction; idempotency_hits: IdempotencyHit[] } }> {
    const { run } = await this.ensureInitialized(req);

    // Budget guard (reject starting new steps if already over budget)
    if (run.cost_usd > run.budget_usd) {
      run.status = 'blocked_error';
      run.blocked_reason = `budget_exceeded: cost_usd=${run.cost_usd} > budget_usd=${run.budget_usd}`;
      run.updated_at = nowIso();
      await this.putRun(run);
      return {
        data: {
          run,
          action: { action: 'run_blocked', status: run.status, reason: run.blocked_reason },
          idempotency_hits: [],
        },
      };
    }

    const { action, idempotency_hits } = await this.driveRunCollectingIdempotencyHits();
    const latestRun = (await this.getRun()) ?? run;
    return { data: { run: latestRun, action, idempotency_hits } };
  }

  private async handleStepComplete(req: StepCompleteRequest): Promise<{ data: { run: RunState; action: DriveAction; idempotency_hits: IdempotencyHit[] } }> {
    const run = await this.getRun();
    if (!run) {
      return {
        data: {
          run: this.syntheticMissingRun(req.seq),
          action: { action: 'run_blocked', status: 'failed', reason: 'Run not initialized' },
          idempotency_hits: [],
        },
      };
    }

    // Terminal states: treat as idempotent acknowledgement.
    if (run.status === 'succeeded') {
      return { data: { run, action: { action: 'run_done', status: run.status }, idempotency_hits: [] } };
    }
    if (run.status === 'cancelled') {
      return { data: { run, action: { action: 'run_cancelled', status: run.status, reason: run.cancelled_reason }, idempotency_hits: [] } };
    }
    if (run.status === 'blocked_error') {
      return { data: { run, action: { action: 'run_blocked', status: run.status, reason: run.blocked_reason }, idempotency_hits: [] } };
    }

    const step = await this.getStep(req.seq);
    if (!step) {
      return { data: { run, action: { action: 'run_blocked', status: 'blocked_error', reason: `Unknown step seq=${req.seq}` }, idempotency_hits: [] } };
    }

    // If step already terminal, accept idempotently and continue driving.
    if (step.status === 'succeeded') {
      const { action, idempotency_hits } = await this.driveRunCollectingIdempotencyHits();
      const latestRun = (await this.getRun()) ?? run;
      return { data: { run: latestRun, action, idempotency_hits } };
    }

    // Only allow completion of a running step; otherwise treat as conflict but still attempt to drive.
    if (step.status !== 'running') {
      safeLog.warn('[RunCoordinator] step-complete for non-running step', { seq: req.seq, status: step.status });
      const { action, idempotency_hits } = await this.driveRunCollectingIdempotencyHits();
      const latestRun = (await this.getRun()) ?? run;
      return { data: { run: latestRun, action, idempotency_hits } };
    }

    const now = nowIso();

    if (req.status === 'succeeded') {
      step.status = 'succeeded';
      step.completed_at = now;
      step.updated_at = now;
      step.result = req.result;
      const deltaCost = Number(req.cost_usd ?? 0);
      if (Number.isFinite(deltaCost) && deltaCost > 0) {
        step.cost_usd += deltaCost;
        run.cost_usd += deltaCost;
      }

      // Cache idempotency result for future duplicate requests/retries
      const record: IdempotencyRecord = {
        key: step.idempotency_key,
        stored_at: now,
        result: req.result,
      };
      await this.ctx.storage.put(idempotencyStorageKey(step.idempotency_key), record);

      run.updated_at = now;
      run.current_seq = undefined;

      await this.putStep(step);
      await this.putRun(run);

      // Budget guard after cost update: stop before starting new step
      if (run.cost_usd > run.budget_usd) {
        run.status = 'blocked_error';
        run.blocked_reason = `budget_exceeded: cost_usd=${run.cost_usd} > budget_usd=${run.budget_usd}`;
        run.updated_at = nowIso();
        await this.putRun(run);
        return { data: { run, action: { action: 'run_blocked', status: run.status, reason: run.blocked_reason }, idempotency_hits: [] } };
      }

      const { action, idempotency_hits } = await this.driveRunCollectingIdempotencyHits();
      const latestRun = (await this.getRun()) ?? run;
      return { data: { run: latestRun, action, idempotency_hits } };
    }

    // Failed
    step.error = req.error ?? 'step_failed';
    step.completed_at = now;
    step.updated_at = now;
    step.status = 'failed';

    await this.putStep(step);

    if (step.attempts >= step.max_attempts) {
      run.status = 'blocked_error';
      run.blocked_reason = `step_failed_max_attempts: seq=${step.seq} attempts=${step.attempts}/${step.max_attempts}`;
      run.updated_at = nowIso();
      run.current_seq = undefined;
      await this.putRun(run);
      return { data: { run, action: { action: 'run_blocked', status: run.status, reason: run.blocked_reason }, idempotency_hits: [] } };
    }

    // Retry: put step back to pending and drive again (will re-start same seq).
    step.status = 'pending';
    step.started_at = undefined;
    step.updated_at = nowIso();
    await this.putStep(step);

    run.updated_at = nowIso();
    run.current_seq = undefined;
    await this.putRun(run);

    const { action, idempotency_hits } = await this.driveRunCollectingIdempotencyHits();
    const latestRun = (await this.getRun()) ?? run;
    return { data: { run: latestRun, action, idempotency_hits } };
  }

  private async handleGetState(): Promise<{ run: RunState | null; steps: StepState[] }> {
    const run = await this.getRun();
    const steps = await this.listSteps();
    steps.sort((a, b) => a.seq - b.seq);
    return { run, steps };
  }

  private async handleCancel(req: CancelRequest): Promise<{ data: { run: RunState; steps_updated: number } }> {
    const run = await this.getRun();
    if (!run) {
      return {
        data: {
          run: {
            run_id: 'unknown',
            status: 'cancelled',
            budget_usd: 0,
            cost_usd: 0,
            step_count: 0,
            created_at: nowIso(),
            updated_at: nowIso(),
            cancelled_reason: req.reason ?? 'cancelled',
          },
          steps_updated: 0,
        },
      };
    }

    if (run.status === 'cancelled') {
      return { data: { run, steps_updated: 0 } };
    }

    const steps = await this.listSteps();
    let updated = 0;
    const now = nowIso();
    for (const step of steps) {
      if (step.status === 'succeeded' || step.status === 'failed' || step.status === 'skipped') continue;
      step.status = 'skipped';
      step.completed_at = now;
      step.started_at = step.started_at ?? now;
      step.updated_at = now;
      await this.putStep(step);
      updated++;
    }

    run.status = 'cancelled';
    run.cancelled_reason = req.reason ?? 'cancelled';
    run.updated_at = now;
    run.current_seq = undefined;
    await this.putRun(run);

    return { data: { run, steps_updated: updated } };
  }

  // =============================================================================
  // Alarm (stuck detection / retry)
  // =============================================================================

  async alarm(): Promise<void> {
    try {
      const run = await this.getRun();
      if (!run) return;

      if (run.status !== 'running') return;

      const steps = await this.listSteps();
      const running = steps.find((s) => s.status === 'running');
      if (!running || !running.started_at) return;

      const startedAtMs = Date.parse(running.started_at);
      const nowMs = Date.now();
      if (!Number.isFinite(startedAtMs)) return;

      if (nowMs - startedAtMs <= STUCK_STEP_MS) return;

      const now = nowIso();
      safeLog.warn('[RunCoordinator] Stuck step detected', {
        runId: run.run_id,
        seq: running.seq,
        started_at: running.started_at,
        attempts: running.attempts,
      });

      // Mark attempt failed
      running.status = 'failed';
      running.error = 'stuck_timeout';
      running.completed_at = now;
      running.updated_at = now;
      await this.putStep(running);

      if (running.attempts >= running.max_attempts) {
        run.status = 'blocked_error';
        run.blocked_reason = `stuck_step_max_attempts: seq=${running.seq} attempts=${running.attempts}/${running.max_attempts}`;
        run.updated_at = now;
        run.current_seq = undefined;
        await this.putRun(run);
        return;
      }

      // Retry by returning step to pending (executor must call /start again to pull)
      running.status = 'pending';
      running.started_at = undefined;
      running.updated_at = nowIso();
      await this.putStep(running);

      run.updated_at = nowIso();
      run.current_seq = undefined;
      await this.putRun(run);
    } finally {
      // Always schedule next alarm
      await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
    }
  }

  // =============================================================================
  // Core State Machine
  // =============================================================================

  /**
   * Attempt to move the run forward:
   * - If all steps succeeded -> run succeeded
   * - Else start the next pending step in seq order
   * - Before starting, apply budget guard and idempotency cache check
   *
   * This method is the single place that performs "start step" transitions.
   */
  private async driveRunCollectingIdempotencyHits(): Promise<DriveResult> {
    const idempotency_hits: IdempotencyHit[] = [];

    while (true) {
      const run = await this.getRun();
      if (!run) return { action: { action: 'run_blocked', status: 'failed', reason: 'Run not initialized' }, idempotency_hits };

      if (run.status === 'succeeded') return { action: { action: 'run_done', status: run.status }, idempotency_hits };
      if (run.status === 'cancelled') return { action: { action: 'run_cancelled', status: run.status, reason: run.cancelled_reason }, idempotency_hits };
      if (run.status === 'blocked_error') return { action: { action: 'run_blocked', status: run.status, reason: run.blocked_reason }, idempotency_hits };

      const steps = await this.listSteps();
      steps.sort((a, b) => a.seq - b.seq);

      const running = steps.find((s) => s.status === 'running');
      if (running) {
        run.current_seq = running.seq;
        run.updated_at = nowIso();
        await this.putRun(run);
        return {
          action: {
            action: 'awaiting_step',
            step: {
              seq: running.seq,
              status: running.status,
              started_at: running.started_at,
              attempts: running.attempts,
              max_attempts: running.max_attempts,
            },
          },
          idempotency_hits,
        };
      }

      const allSucceeded = steps.length > 0 && steps.every((s) => s.status === 'succeeded' || s.status === 'skipped');
      if (allSucceeded) {
        run.status = 'succeeded';
        run.updated_at = nowIso();
        run.current_seq = undefined;
        await this.putRun(run);
        return { action: { action: 'run_done', status: run.status }, idempotency_hits };
      }

      const next = steps.find((s) => s.status === 'pending');
      if (!next) {
        return { action: { action: 'run_blocked', status: 'blocked_error', reason: 'No pending steps and run not complete' }, idempotency_hits };
      }

      if (run.cost_usd > run.budget_usd) {
        run.status = 'blocked_error';
        run.blocked_reason = `budget_exceeded: cost_usd=${run.cost_usd} > budget_usd=${run.budget_usd}`;
        run.updated_at = nowIso();
        await this.putRun(run);
        return { action: { action: 'run_blocked', status: run.status, reason: run.blocked_reason }, idempotency_hits };
      }

      const cached = await this.ctx.storage.get<IdempotencyRecord>(idempotencyStorageKey(next.idempotency_key));
      if (cached) {
        const now = nowIso();
        next.status = 'succeeded';
        next.result = cached.result;
        next.completed_at = now;
        next.updated_at = now;
        await this.putStep(next);

        run.updated_at = now;
        await this.putRun(run);

        idempotency_hits.push({ seq: next.seq, key: next.idempotency_key, result: cached.result });
        continue;
      }

      if (run.status === 'pending') {
        run.status = 'running';
      }

      const now = nowIso();
      next.status = 'running';
      next.started_at = now;
      next.updated_at = now;
      next.attempts += 1;
      await this.putStep(next);

      run.current_seq = next.seq;
      run.updated_at = now;
      await this.putRun(run);

      return {
        action: {
          action: 'execute_step',
          step: {
            seq: next.seq,
            agent: next.agent,
            input: next.input,
            attempts: next.attempts,
            max_attempts: next.max_attempts,
            idempotency_key: next.idempotency_key,
          },
        },
        idempotency_hits,
      };
    }
  }

  // =============================================================================
  // Storage IO
  // =============================================================================

  private async getRun(): Promise<RunState | null> {
    return (await this.ctx.storage.get<RunState>('run_state')) ?? null;
  }

  private async putRun(run: RunState): Promise<void> {
    // Defensive validation: run status must remain within schema.
    const parsed = RunStatusSchema.safeParse(run.status);
    if (!parsed.success) throw new Error(`Invalid run status: ${String(run.status)}`);
    await this.ctx.storage.put('run_state', run);
  }

  private async getStep(seq: number): Promise<StepState | null> {
    return (await this.ctx.storage.get<StepState>(stepStorageKey(seq))) ?? null;
  }

  private async putStep(step: StepState): Promise<void> {
    const parsed = StepStatusSchema.safeParse(step.status);
    if (!parsed.success) throw new Error(`Invalid step status: ${String(step.status)}`);
    await this.ctx.storage.put(stepStorageKey(step.seq), step);
  }

  private async listSteps(): Promise<StepState[]> {
    const all = await this.ctx.storage.list<StepState>({ prefix: 'step:' });
    const steps: StepState[] = [];
    for (const [, v] of all) steps.push(v);
    return steps;
  }

  /**
   * Initialize run_state and step:{seq} if missing.
   * If already initialized, does not overwrite existing step states (idempotent).
   */
  private async ensureInitialized(req: StartRequest): Promise<{ run: RunState; steps: StepState[] }> {
    const existingRun = await this.getRun();
    const now = nowIso();

    let run: RunState;
    if (!existingRun) {
      run = {
        run_id: req.run_id,
        status: 'pending',
        budget_usd: req.budget_usd,
        cost_usd: req.cost_usd ?? 0,
        step_count: req.steps.length,
        created_at: now,
        updated_at: now,
      };
      await this.putRun(run);
    } else {
      run = existingRun;
      // Keep budget/cost in sync if caller provides updated values.
      // DO remains source of truth for cost_usd increments after step completion.
      if (Number.isFinite(req.budget_usd) && req.budget_usd !== run.budget_usd) run.budget_usd = req.budget_usd;
      if (Number.isFinite(req.cost_usd ?? NaN) && typeof req.cost_usd === 'number' && req.cost_usd > run.cost_usd) run.cost_usd = req.cost_usd;
      run.updated_at = now;
      await this.putRun(run);
    }

    // Initialize missing steps.
    const stepsInStorage = await this.listSteps();
    const bySeq = new Map<number, StepState>();
    for (const s of stepsInStorage) bySeq.set(s.seq, s);

    for (const s of req.steps) {
      if (bySeq.has(s.seq)) continue;
      const idemKey = await hashJson(s.input);
      const step: StepState = {
        seq: s.seq,
        status: 'pending',
        agent: s.agent,
        attempts: 0,
        max_attempts: s.max_attempts ?? DEFAULT_MAX_ATTEMPTS,
        idempotency_key: idemKey,
        input: s.input,
        cost_usd: 0,
        updated_at: nowIso(),
      };
      await this.putStep(step);
      bySeq.set(step.seq, step);
    }

    const steps = Array.from(bySeq.values());
    steps.sort((a, b) => a.seq - b.seq);

    // Ensure run.step_count reflects what we manage.
    if (run.step_count !== steps.length) {
      run.step_count = steps.length;
      run.updated_at = nowIso();
      await this.putRun(run);
    }

    return { run, steps };
  }

  private syntheticMissingRun(seq: number): RunState {
    const now = nowIso();
    return {
      run_id: 'unknown',
      status: 'failed',
      budget_usd: 0,
      cost_usd: 0,
      step_count: 0,
      current_seq: seq,
      blocked_reason: 'Run not initialized',
      created_at: now,
      updated_at: now,
    };
  }
}
