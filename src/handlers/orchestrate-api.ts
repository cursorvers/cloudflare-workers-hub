/**
 * FUGUE Orchestration API Handler
 *
 * Persistent orchestration run management.
 * Dashboard -> Workers Hub -> Durable Object (RunCoordinator) pipeline.
 *
 * ## Endpoints
 * - POST /api/orchestrate           - Create a new run (202 Accepted)
 * - GET  /api/runs/:run_id          - Get run details + steps
 * - GET  /api/runs/:run_id/steps    - Get steps for a run
 * - POST /api/runs/:run_id/resume   - Resume a blocked/failed run
 * - POST /api/approvals/:id/decision - Approve or reject a pending step
 */

import type { Env } from '../types';
import { safeLog } from '../utils/log-sanitizer';
import {
  authenticateRequest,
  type UserRole,
} from '../utils/jwt-auth';
import {
  authenticateWithAccess,
  mapAccessUserToInternal,
} from '../utils/cloudflare-access';
import {
  checkRateLimit,
  createRateLimitErrorResponse,
} from '../utils/rate-limiter';
import {
  CreateRunRequestSchema,
  ResumeRunRequestSchema,
  ApprovalDecisionSchema,
  type Run,
  type Step,
} from '../schemas/orchestration';
import { LlmGateway } from '../services/llm-gateway';
import {
  TaskPackGenerator,
  createDefaultDelegationMatrix,
} from '../services/task-pack-generator';
import {
  type RunEvent,
  type DriveAction,
  type DOResponse,
} from '../services/step-executor';

// =============================================================================
// Helpers
// =============================================================================

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorResponse(code: string, message: string, status: number): Response {
  return jsonResponse({ success: false, error: { code, message } }, status);
}

/**
 * Extract owner_id from request via Cloudflare Access or JWT
 */
async function extractOwnerId(
  request: Request,
  env: Env,
): Promise<{ ownerId: string; role: UserRole } | Response> {
  // Rate limit
  const rateLimitResult = await checkRateLimit(request, env);
  if (!rateLimitResult.allowed) {
    return createRateLimitErrorResponse(rateLimitResult);
  }

  // Try Cloudflare Access first
  const accessResult = await authenticateWithAccess(request, env);
  if (accessResult.verified && accessResult.email) {
    const internalUser = await mapAccessUserToInternal(accessResult.email, env);
    if (internalUser) {
      return { ownerId: internalUser.userId, role: internalUser.role as UserRole };
    }
  }

  // Fallback to JWT
  const authResult = await authenticateRequest(request, env);
  if (!authResult.authenticated || !authResult.userId) {
    return errorResponse('UNAUTHORIZED', 'Authentication required', 401);
  }

  return { ownerId: authResult.userId, role: (authResult.role ?? 'viewer') as UserRole };
}

// =============================================================================
// Route Handler
// =============================================================================

export async function handleOrchestrateAPI(
  request: Request,
  env: Env,
  path: string,
  ctx?: ExecutionContext,
): Promise<Response> {
  const db = env.DB;
  if (!db) {
    return errorResponse('SERVICE_UNAVAILABLE', 'Database not available', 503);
  }

  // Authenticate
  const auth = await extractOwnerId(request, env);
  if (auth instanceof Response) return auth;
  const { ownerId } = auth;

  // Route matching
  const method = request.method;

  // POST /api/orchestrate
  if (path === '/api/orchestrate' && method === 'POST') {
    return handleCreateRun(request, env, db, ownerId, ctx);
  }

  // GET /api/runs/:run_id/steps
  const stepsMatch = path.match(/^\/api\/runs\/([^/]+)\/steps$/);
  if (stepsMatch && method === 'GET') {
    return handleGetSteps(db, ownerId, stepsMatch[1]);
  }

  // POST /api/runs/:run_id/resume
  const resumeMatch = path.match(/^\/api\/runs\/([^/]+)\/resume$/);
  if (resumeMatch && method === 'POST') {
    return handleResumeRun(request, env, db, ownerId, resumeMatch[1]);
  }

  // GET /api/runs/:run_id
  const runMatch = path.match(/^\/api\/runs\/([^/]+)$/);
  if (runMatch && method === 'GET') {
    return handleGetRun(db, ownerId, runMatch[1]);
  }

  // POST /api/approvals/:id/decision
  const approvalMatch = path.match(/^\/api\/approvals\/([^/]+)\/decision$/);
  if (approvalMatch && method === 'POST') {
    return handleApprovalDecision(request, db, ownerId, approvalMatch[1]);
  }

  return errorResponse('NOT_FOUND', 'Endpoint not found', 404);
}

// =============================================================================
// Endpoint Handlers
// =============================================================================

/**
 * POST /api/orchestrate -> 202 { run_id, ws_channel }
 * Creates D1 record and initializes RunCoordinator DO
 */
async function handleCreateRun(
  request: Request,
  env: Env,
  db: D1Database,
  ownerId: string,
  ctx?: ExecutionContext,
): Promise<Response> {
  const body = await request.json().catch(() => null);
  if (!body) {
    return errorResponse('INVALID_BODY', 'Request body must be valid JSON', 400);
  }

  const parsed = CreateRunRequestSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse('VALIDATION_ERROR', parsed.error.message, 400);
  }

  const { instruction, budget_usd, max_steps } = parsed.data;
  const runId = crypto.randomUUID();
  const now = new Date().toISOString();

  // Persist to D1 (source of truth for listing/queries)
  await db
    .prepare(
      `INSERT INTO runs (run_id, owner_id, instruction, status, budget_usd, cost_usd, memory_json, step_count, max_steps, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', ?, 0.0, '{}', 0, ?, ?, ?)`,
    )
    .bind(runId, ownerId, instruction, budget_usd, max_steps, now, now)
    .run();

  safeLog.info('[Orchestrate] Run created', { runId, ownerId });

  // Day 3: Background task decomposition via LLM Gateway + Task Pack Generator
  // Uses waitUntil to avoid blocking the 202 response (Design: Case B)
  if (env.RUN_COORDINATOR) {
    const bgPromise = decomposeAndStart(env, db, runId, instruction, budget_usd);
    if (ctx) {
      ctx.waitUntil(bgPromise);
    } else {
      // Best-effort: fire-and-forget (will run until Worker terminates)
      void bgPromise;
    }
  } else {
    safeLog.warn('[Orchestrate] RUN_COORDINATOR binding missing, skipping decomposition', { runId });
  }

  return jsonResponse(
    {
      success: true,
      data: {
        run_id: runId,
        ws_channel: `run:${runId}`,
      },
    },
    202,
  );
}

/**
 * Background: decompose instruction into steps and start the DO run.
 * Errors are caught and recorded as blocked_error on the run.
 */
async function decomposeAndStart(
  env: Env,
  db: D1Database,
  runId: string,
  instruction: string,
  budgetUsd: number,
): Promise<void> {
  try {
    const llm = new LlmGateway(env);
    const generator = new TaskPackGenerator({
      llm,
      delegation: createDefaultDelegationMatrix(),
    });

    const taskPack = await generator.generate({ instruction, requestId: runId });

    const ce = taskPack.costEvent;
    await recordCostEvent(db, runId, ce);
    await updateRunStepCount(db, runId, taskPack.steps.length);
    await insertStepsToD1(db, runId, taskPack.steps);

    const { stub, bearerToken } = await startRunCoordinator(env, runId, budgetUsd, taskPack.steps);
    await markRunRunning(db, runId);

    safeLog.info('[Orchestrate] Decomposition complete, DO started', {
      runId,
      stepCount: taskPack.steps.length,
      costUsd: ce.usd,
    });

    emitRunEvent(env, {
      event: 'run:created',
      run_id: runId,
      ts: new Date().toISOString(),
      data: { step_count: taskPack.steps.length, budget_usd: budgetUsd },
    });

    await syncRunStatusToD1(stub, bearerToken, db, runId);
  } catch (err) {
    safeLog.error('[Orchestrate] Decomposition failed', {
      runId,
      error: err instanceof Error ? err.message : String(err),
    });
    await markRunBlockedError(db, runId, err);
  }
}

function getDoBearerToken(env: Env): string {
  return env.WORKERS_API_KEY ?? env.ASSISTANT_API_KEY ?? env.QUEUE_API_KEY ?? '';
}

async function markRunBlockedError(db: D1Database, runId: string, err: unknown): Promise<void> {
  try {
    const errMsg = err instanceof Error ? err.message : String(err);
    await db
      .prepare("UPDATE runs SET status = 'blocked_error', memory_json = ?, updated_at = ? WHERE run_id = ?")
      .bind(JSON.stringify({ error: errMsg.slice(0, 500) }), new Date().toISOString(), runId)
      .run();
  } catch (dbErr: unknown) {
    safeLog.error('[Orchestrate] Failed to update run status', { runId, dbErr: String(dbErr) });
  }
}

async function recordCostEvent(
  db: D1Database,
  runId: string,
  ce: Readonly<{ provider: string; model: string; tokens_in: number; tokens_out: number; usd: number }>,
): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO cost_events (run_id, provider, model, tokens_in, tokens_out, usd, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(runId, ce.provider, ce.model, ce.tokens_in, ce.tokens_out, ce.usd, new Date().toISOString())
      .run();
  } catch (err: unknown) {
    safeLog.warn('[Orchestrate] Failed to record cost event', { runId, err: String(err) });
  }
}

async function updateRunStepCount(db: D1Database, runId: string, stepCount: number): Promise<void> {
  try {
    await db
      .prepare('UPDATE runs SET step_count = ?, updated_at = ? WHERE run_id = ?')
      .bind(stepCount, new Date().toISOString(), runId)
      .run();
  } catch (err: unknown) {
    safeLog.warn('[Orchestrate] Failed to update step_count', { runId, err: String(err) });
  }
}

async function insertStepsToD1(
  db: D1Database,
  runId: string,
  steps: ReadonlyArray<Readonly<{ seq: number; agent: string; max_attempts?: number }>>,
): Promise<void> {
  const createdAt = new Date().toISOString();
  const promises = steps.map((s) =>
    db
      .prepare(
        `INSERT INTO steps (step_id, run_id, seq, status, agent, attempts, max_attempts, idempotency_key, cost_usd, created_at)
         VALUES (?, ?, ?, 'pending', ?, 0, ?, ?, 0.0, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        runId,
        s.seq,
        s.agent,
        s.max_attempts ?? 3,
        `${runId}:${s.seq}`,
        createdAt,
      )
      .run(),
  );
  await Promise.all(promises);
}

async function startRunCoordinator(
  env: Env,
  runId: string,
  budgetUsd: number,
  steps: ReadonlyArray<Readonly<{ seq: number; agent: string; input: unknown; max_attempts?: number }>>,
): Promise<{ stub: DurableObjectStub; bearerToken: string }> {
  const doId = env.RUN_COORDINATOR!.idFromName(runId);
  const stub = env.RUN_COORDINATOR!.get(doId);
  const bearerToken = getDoBearerToken(env);

  if (!bearerToken) safeLog.warn('[Orchestrate] No API key available for DO auth', { runId });

  const startRes = await stub.fetch(
    new Request('https://do/start', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {}),
      },
      body: JSON.stringify({
        run_id: runId,
        budget_usd: budgetUsd,
        steps: steps.map((s) => ({
          seq: s.seq,
          agent: s.agent,
          input: s.input,
          max_attempts: s.max_attempts ?? 3,
        })),
      }),
    }),
  );

  if (!startRes.ok) {
    const errText = await startRes.text().catch(() => 'unknown');
    throw new Error(`DO /start failed: ${startRes.status} ${errText.slice(0, 500)}`);
  }

  return { stub, bearerToken };
}

async function markRunRunning(db: D1Database, runId: string): Promise<void> {
  await db
    .prepare("UPDATE runs SET status = 'running', updated_at = ? WHERE run_id = ?")
    .bind(new Date().toISOString(), runId)
    .run();
}

// =============================================================================
// Event & Sync Helpers
// =============================================================================

/**
 * Emit a run event to SystemEvents DO for recording and WebSocket broadcast.
 * Fire-and-forget: errors are logged but don't block execution.
 */
function emitRunEvent(env: Env, event: RunEvent): void {
  if (!env.SYSTEM_EVENTS) return;

  try {
    const doId = env.SYSTEM_EVENTS.idFromName('default');
    const stub = env.SYSTEM_EVENTS.get(doId);

    void stub.fetch(new Request('https://do/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'add-event',
        event: {
          id: crypto.randomUUID(),
          level: event.event.includes('blocked') || event.event.includes('failed') ? 'warning' : 'info',
          title: `${event.event} (run:${event.run_id.slice(0, 8)})`,
          message: JSON.stringify(event.data).slice(0, 500),
          createdAt: Date.now(),
          source: 'orchestration',
          metadata: {
            run_id: event.run_id,
            seq: event.seq,
            originalEvent: event.event,
          },
        },
      }),
    })).catch((err: unknown) => {
      safeLog.warn('[Orchestrate] Failed to emit event', { event: event.event, err: String(err) });
    });
  } catch (err) {
    safeLog.warn('[Orchestrate] Failed to create SystemEvents stub', { err: String(err) });
  }
}

/**
 * Sync final run status from DO to D1.
 * Queries DO /state and updates D1 accordingly.
 */
async function syncRunStatusToD1(
  stub: DurableObjectStub,
  bearerToken: string,
  db: D1Database,
  runId: string,
): Promise<void> {
  try {
    const stateRes = await stub.fetch(new Request('https://do/state', {
      method: 'GET',
      headers: bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {},
    }));

    if (!stateRes.ok) return;

    const stateBody = (await stateRes.json()) as { data?: { run?: { status?: string; cost_usd?: number } } };
    const doRun = stateBody.data?.run;
    if (!doRun?.status) return;

    await db
      .prepare('UPDATE runs SET status = ?, cost_usd = ?, updated_at = ? WHERE run_id = ?')
      .bind(doRun.status, doRun.cost_usd ?? 0, new Date().toISOString(), runId)
      .run();

    safeLog.info('[Orchestrate] D1 synced from DO', { runId, status: doRun.status, costUsd: doRun.cost_usd });
  } catch (err) {
    safeLog.warn('[Orchestrate] D1 sync failed', { runId, err: String(err) });
  }
}

/**
 * GET /api/runs/:run_id -> Run + Steps
 */
async function handleGetRun(
  db: D1Database,
  ownerId: string,
  runId: string,
): Promise<Response> {
  const run = await db
    .prepare('SELECT * FROM runs WHERE run_id = ? AND owner_id = ?')
    .bind(runId, ownerId)
    .first<Run>();

  if (!run) {
    return errorResponse('NOT_FOUND', 'Run not found', 404);
  }

  const { results: steps } = await db
    .prepare('SELECT * FROM steps WHERE run_id = ? ORDER BY seq ASC')
    .bind(runId)
    .all<Step>();

  return jsonResponse({
    success: true,
    data: { ...run, steps: steps ?? [] },
  });
}

/**
 * GET /api/runs/:run_id/steps -> Step[]
 */
async function handleGetSteps(
  db: D1Database,
  ownerId: string,
  runId: string,
): Promise<Response> {
  // Verify ownership
  const run = await db
    .prepare('SELECT run_id FROM runs WHERE run_id = ? AND owner_id = ?')
    .bind(runId, ownerId)
    .first();

  if (!run) {
    return errorResponse('NOT_FOUND', 'Run not found', 404);
  }

  const { results: steps } = await db
    .prepare('SELECT * FROM steps WHERE run_id = ? ORDER BY seq ASC')
    .bind(runId)
    .all<Step>();

  return jsonResponse({
    success: true,
    data: steps ?? [],
  });
}

/**
 * POST /api/runs/:run_id/resume -> 200
 * Only allowed when run status is 'blocked_error' or 'failed'
 */
async function handleResumeRun(
  request: Request,
  env: Env,
  db: D1Database,
  ownerId: string,
  runId: string,
): Promise<Response> {
  const body = await request.json().catch(() => ({}));
  const parsed = ResumeRunRequestSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse('VALIDATION_ERROR', parsed.error.message, 400);
  }

  const { step_id: stepId, override_instruction: overrideInstruction } = parsed.data;

  // Atomic: UPDATE with status condition to prevent race conditions
  const now = new Date().toISOString();
  const result = await db
    .prepare(
      "UPDATE runs SET status = 'running', updated_at = ? WHERE run_id = ? AND owner_id = ? AND status IN ('blocked_error', 'failed')",
    )
    .bind(now, runId, ownerId)
    .run();

  if (!result.meta.changes) {
    // Determine reason: not found or wrong status
    const run = await db
      .prepare('SELECT status FROM runs WHERE run_id = ? AND owner_id = ?')
      .bind(runId, ownerId)
      .first<{ status: string }>();

    if (!run) {
      return errorResponse('NOT_FOUND', 'Run not found', 404);
    }
    return errorResponse(
      'INVALID_STATE',
      `Cannot resume run in '${run.status}' state. Must be 'blocked_error' or 'failed'.`,
      409,
    );
  }

  safeLog.info('[Orchestrate] Run resumed', { runId, ownerId });

  try {
    await resumeRunCoordinator(env, db, runId, ownerId, stepId, overrideInstruction);
  } catch (err: unknown) {
    safeLog.error('[Orchestrate] DO resume failed', { runId, err: String(err) });
    await rollbackResumeFailure(db, runId, ownerId, err);
    return errorResponse('RESUME_FAILED', 'Failed to resume run coordinator', 502);
  }

  return jsonResponse({ success: true, data: { run_id: runId, status: 'running' } });
}

async function resolveSeqForStepId(
  db: D1Database,
  runId: string,
  ownerId: string,
  stepId: string,
): Promise<number | undefined> {
  const row = await db
    .prepare(
      `SELECT s.seq AS seq FROM steps s
       JOIN runs r ON s.run_id = r.run_id
       WHERE s.step_id = ? AND r.run_id = ? AND r.owner_id = ?`,
    )
    .bind(stepId, runId, ownerId)
    .first<{ seq: number }>();
  return row?.seq;
}

async function resumeRunCoordinator(
  env: Env,
  db: D1Database,
  runId: string,
  ownerId: string,
  stepId?: string,
  overrideInstruction?: string,
): Promise<void> {
  if (!env.RUN_COORDINATOR) throw new Error('RUN_COORDINATOR binding missing');

  const seq = stepId ? await resolveSeqForStepId(db, runId, ownerId, stepId) : undefined;
  const bearerToken = getDoBearerToken(env);
  const stub = env.RUN_COORDINATOR.get(env.RUN_COORDINATOR.idFromName(runId));

  const resp = await stub.fetch(
    new Request('https://do/resume', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {}),
      },
      body: JSON.stringify({
        ...(seq ? { seq } : {}),
        ...(overrideInstruction ? { reason: 'override_instruction_provided' } : {}),
      }),
    }),
  );

  if (!resp.ok) {
    const errText = await resp.text().catch(() => 'unknown');
    throw new Error(`DO /resume failed: ${resp.status} ${errText.slice(0, 500)}`);
  }

  await syncRunStatusToD1(stub, bearerToken, db, runId);
}

async function rollbackResumeFailure(db: D1Database, runId: string, ownerId: string, err: unknown): Promise<void> {
  try {
    await db
      .prepare("UPDATE runs SET status = 'blocked_error', memory_json = ?, updated_at = ? WHERE run_id = ? AND owner_id = ?")
      .bind(JSON.stringify({ error: `do_resume_failed: ${String(err).slice(0, 500)}` }), new Date().toISOString(), runId, ownerId)
      .run();
  } catch (dbErr: unknown) {
    safeLog.error('[Orchestrate] Failed to rollback run status', { runId, dbErr: String(dbErr) });
  }
}

/**
 * POST /api/approvals/:id/decision -> 200
 * Approve or reject a blocked step
 */
async function handleApprovalDecision(
  request: Request,
  db: D1Database,
  ownerId: string,
  stepId: string,
): Promise<Response> {
  const body = await request.json().catch(() => null);
  if (!body) {
    return errorResponse('INVALID_BODY', 'Request body must be valid JSON', 400);
  }

  const parsed = ApprovalDecisionSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse('VALIDATION_ERROR', parsed.error.message, 400);
  }

  const { decision } = parsed.data;
  const newStatus = decision === 'approve' ? 'pending' : 'skipped';
  const now = new Date().toISOString();

  // Atomic: UPDATE with status + ownership condition to prevent race conditions
  const result = await db
    .prepare(
      `UPDATE steps SET status = ?, completed_at = ?
       WHERE step_id = ? AND status = 'blocked'
       AND run_id IN (SELECT run_id FROM runs WHERE owner_id = ?)`,
    )
    .bind(newStatus, decision === 'reject' ? now : null, stepId, ownerId)
    .run();

  if (!result.meta.changes) {
    // Determine reason: not found or wrong status
    const step = await db
      .prepare(
        `SELECT s.status FROM steps s
         JOIN runs r ON s.run_id = r.run_id
         WHERE s.step_id = ? AND r.owner_id = ?`,
      )
      .bind(stepId, ownerId)
      .first<{ status: string }>();

    if (!step) {
      return errorResponse('NOT_FOUND', 'Step not found', 404);
    }
    return errorResponse(
      'INVALID_STATE',
      `Cannot decide on step in '${step.status}' state. Must be 'blocked'.`,
      409,
    );
  }

  safeLog.info('[Orchestrate] Approval decision', { stepId, decision, ownerId });

  return jsonResponse({
    success: true,
    data: { step_id: stepId, decision, new_status: newStatus },
  });
}
