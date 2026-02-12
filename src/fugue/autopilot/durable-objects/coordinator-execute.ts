/**
 * Coordinator Execute Module — Extracted from AutopilotCoordinator.
 *
 * Handles POST /execute (sync/async), POST /task/:id (polling),
 * and all execution-related helpers.
 *
 * Injected dependencies via CoordinatorExecuteContext (DI).
 * Keeps DO class under 800 lines.
 */

import type { PolicyContext, PolicyDecision } from '../policy/types';
import { evaluatePolicy } from '../policy/engine';
import { DEFAULT_RULES } from '../policy/rules';
import { classifyRisk } from '../risk/classifier';
import { BUDGET_STATES, EFFECT_TYPES, ORIGINS, SUBJECT_TYPES, TRUST_ZONES } from '../types';
import type { EffectType } from '../types';
import type { ToolRequest, ToolResult } from '../executor/types';
import { ToolResultKind, ErrorCode, freezeToolResult } from '../executor/types';
import {
  createExecutorWorker,
  incrementWeeklyCount,
  type ExecutorStorage,
} from '../executor/factory';
import { validateExecuteRequest, MAX_EXECUTE_BODY_SIZE } from '../executor/validation';
import {
  type ExecutionQueueState,
  type ExecutionResult,
  type ExecutionTask,
  createExecutionTask,
  enqueueExecution,
  createAsyncAcceptedResponse,
  isResultExpired,
  SYNC_EXECUTION_TIMEOUT_MS,
  EXEC_RESULT_PREFIX,
  EXEC_TASK_PREFIX,
  ExecutionTaskPayloadSchema,
} from '../queue/execution-queue';
import type { ExtendedMode } from '../runtime/coordinator';
import { toLegacyMode } from '../runtime/coordinator';
import { safeLog } from '../../../utils/log-sanitizer';

// =============================================================================
// Response helpers (shared with coordinator)
// =============================================================================

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorResponse(message: string, status: number, code?: string): Response {
  return jsonResponse(
    { success: false, error: { code: code ?? 'ERROR', message } },
    status,
  );
}

// =============================================================================
// Dependency Injection Interface
// =============================================================================

/** Idempotency key prefix and TTL (1 hour) */
export const IDEMPOTENCY_PREFIX = 'autopilot:idem:';
export const IDEMPOTENCY_TTL_MS = 60 * 60 * 1000;

export interface IdempotencyEntry {
  readonly result: unknown;
  readonly expiresAt: number;
}

export interface CoordinatorExecuteContext {
  readonly extendedMode: ExtendedMode;
  readonly budgetSpent: number;
  readonly budgetLimit: number;
  readonly apiKeys: {
    readonly OPENAI_API_KEY?: string;
    readonly ZAI_API_KEY?: string;
    readonly GEMINI_API_KEY?: string;
  };
  readonly strictEffects: boolean;
  readonly asyncEnabled: boolean;
  readonly storage: {
    get: <T>(key: string) => Promise<T | undefined>;
    put: (entries: Record<string, unknown>) => Promise<void>;
    delete: (key: string) => Promise<boolean>;
  };
  isOperational: () => boolean;
  getExecutionQueue: () => ExecutionQueueState;
  setExecutionQueue: (state: ExecutionQueueState) => void;
}

// =============================================================================
// POST /execute
// =============================================================================

export async function handleExecuteRequest(
  request: Request,
  ctx: CoordinatorExecuteContext,
): Promise<Response> {
  // 1. Body size check
  const contentLength = parseInt(request.headers.get('content-length') ?? '0', 10);
  if (contentLength > MAX_EXECUTE_BODY_SIZE) {
    return errorResponse('Request body too large', 413, 'PAYLOAD_TOO_LARGE');
  }

  // 2. Parse and validate
  let bodyText: string;
  try {
    bodyText = await request.text();
    if (new TextEncoder().encode(bodyText).byteLength > MAX_EXECUTE_BODY_SIZE) {
      return errorResponse('Request body too large', 413, 'PAYLOAD_TOO_LARGE');
    }
  } catch {
    return errorResponse('Failed to read request body', 400, 'INVALID_BODY');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return errorResponse('Request body must be valid JSON', 400, 'INVALID_BODY');
  }

  const validation = validateExecuteRequest(parsed);
  if (!validation.success || !validation.data) {
    return errorResponse(`Validation failed: ${validation.error}`, 400, 'VALIDATION_ERROR');
  }

  const toolRequest = validation.data.request as unknown as ToolRequest;

  // 3. Check operational state
  if (!ctx.isOperational()) {
    return jsonResponse({
      success: false,
      data: freezeToolResult({
        requestId: toolRequest.id,
        kind: ToolResultKind.FAILURE,
        traceContext: toolRequest.traceContext,
        durationMs: 0,
        completedAt: new Date().toISOString(),
        errorCode: ErrorCode.INTERNAL_ERROR,
        error: `system not operational (mode: ${ctx.extendedMode})`,
        retryable: ctx.extendedMode === 'RECOVERY',
      }),
    }, 503);
  }

  // 4. Idempotency check
  const idemKey = `${IDEMPOTENCY_PREFIX}${toolRequest.idempotencyKey}`;
  const cachedEntry = await ctx.storage.get<IdempotencyEntry>(idemKey);
  if (cachedEntry && cachedEntry.expiresAt > Date.now()) {
    return jsonResponse({ success: true, data: cachedEntry.result });
  }

  // 5. Server-side risk re-classification
  const knownEffectSet = new Set<string>(Object.values(EFFECT_TYPES));
  const validatedEffects: readonly EffectType[] = Object.freeze(
    toolRequest.effects.filter((e): e is EffectType => knownEffectSet.has(e)),
  );
  const hasUnknownEffects = validatedEffects.length !== toolRequest.effects.length;

  if (hasUnknownEffects && ctx.strictEffects) {
    const unknownEffects = toolRequest.effects.filter((e) => !knownEffectSet.has(e));
    return errorResponse(
      `Unknown effects rejected: ${unknownEffects.join(', ')}`,
      400,
      'INVALID_EFFECTS',
    );
  }

  const computedRiskTier = hasUnknownEffects
    ? 4 as const
    : classifyRisk({ effects: validatedEffects, category: toolRequest.category, origin: ORIGINS.INTERNAL });

  if (toolRequest.riskTier !== computedRiskTier) {
    safeLog.warn('[CoordinatorExecute] Risk tier mismatch (client overridden)', {
      requestId: toolRequest.id,
      clientRiskTier: toolRequest.riskTier,
      computedRiskTier,
    });
  }

  // 6. Compute policy decision server-side
  const budgetState = ctx.budgetSpent >= ctx.budgetLimit
    ? BUDGET_STATES.HALTED
    : ctx.budgetSpent >= ctx.budgetLimit * 0.8
      ? BUDGET_STATES.DEGRADED
      : BUDGET_STATES.NORMAL;

  const policyCtx: PolicyContext = {
    subject: { id: 'autopilot-system', type: SUBJECT_TYPES.SYSTEM },
    origin: ORIGINS.INTERNAL,
    effects: validatedEffects,
    riskTier: computedRiskTier,
    trustZone: TRUST_ZONES.TRUSTED_CONFIG,
    budgetState,
    traceContext: toolRequest.traceContext,
  };

  const decision: PolicyDecision = evaluatePolicy(policyCtx, DEFAULT_RULES, []);

  // 7. Execute (sync or async)
  const executorStorage: ExecutorStorage = {
    get: async <T>(key: string) => ctx.storage.get<T>(key),
    put: async (entries: Record<string, unknown>) => ctx.storage.put(entries),
  };

  try {
    const { worker } = await createExecutorWorker({
      env: ctx.apiKeys,
      storage: executorStorage,
      mode: toLegacyMode(ctx.extendedMode),
    });

    if (ctx.asyncEnabled) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), SYNC_EXECUTION_TIMEOUT_MS);

      try {
        const result = await worker.execute(toolRequest, decision, controller.signal);
        clearTimeout(timeoutId);
        await postExecutionCleanup(result, toolRequest, executorStorage, idemKey, ctx);
        return jsonResponse({ success: true, data: result });
      } catch (syncErr) {
        clearTimeout(timeoutId);
        if (controller.signal.aborted) {
          return enqueueAsyncExecution(toolRequest, computedRiskTier, request.url, ctx);
        }
        throw syncErr;
      }
    }

    // Non-async: pure sync
    const result = await worker.execute(toolRequest, decision);
    await postExecutionCleanup(result, toolRequest, executorStorage, idemKey, ctx);
    return jsonResponse({ success: true, data: result });
  } catch (err) {
    safeLog.error('[CoordinatorExecute] Execute error', {
      error: err instanceof Error ? err.message : String(err),
      requestId: toolRequest.id,
    });

    return jsonResponse({
      success: false,
      data: freezeToolResult({
        requestId: toolRequest.id,
        kind: ToolResultKind.FAILURE,
        traceContext: toolRequest.traceContext,
        durationMs: 0,
        completedAt: new Date().toISOString(),
        errorCode: ErrorCode.INTERNAL_ERROR,
        error: 'execution failed',
        retryable: true,
      }),
    }, 500);
  }
}

// =============================================================================
// GET /task/:id — Poll for async result
// =============================================================================

export async function handleTaskPollRequest(
  taskId: string,
  ctx: CoordinatorExecuteContext,
): Promise<Response> {
  if (!taskId || taskId.length > 256) {
    return errorResponse('Invalid task ID', 400, 'VALIDATION_ERROR');
  }

  const resultKey = `${EXEC_RESULT_PREFIX}${taskId}`;
  const result = await ctx.storage.get<ExecutionResult>(resultKey);

  if (result) {
    if (isResultExpired(result, Date.now())) {
      return jsonResponse({ success: false, error: { code: 'EXPIRED', message: 'Task result expired' } }, 410);
    }
    return jsonResponse({
      success: true,
      data: {
        taskId: result.taskId,
        status: result.status,
        data: result.status === 'completed' ? result.data : undefined,
        errorCode: result.status === 'failed' ? result.errorCode : undefined,
        completedAt: result.completedAt,
        durationMs: result.durationMs,
      },
    });
  }

  const taskKey = `${EXEC_TASK_PREFIX}${taskId}`;
  const task = await ctx.storage.get<ExecutionTask>(taskKey);

  if (task) {
    return jsonResponse({
      success: true,
      data: {
        taskId: task.id,
        status: task.status,
        createdAt: task.createdAt,
        retryAfterMs: 5000,
      },
    }, 202);
  }

  return errorResponse('Task not found', 404, 'NOT_FOUND');
}

// =============================================================================
// Helpers
// =============================================================================

async function postExecutionCleanup(
  result: ToolResult,
  toolRequest: ToolRequest,
  storage: ExecutorStorage,
  idemKey: string,
  ctx: CoordinatorExecuteContext,
): Promise<void> {
  if (result.kind === ToolResultKind.SUCCESS && 'executionCost' in result) {
    try {
      await incrementWeeklyCount(storage, (result as { executionCost: { specialistId: string } }).executionCost.specialistId);
    } catch {
      // Weekly count update is non-critical
    }
  }

  try {
    const entry: IdempotencyEntry = Object.freeze({
      result,
      expiresAt: Date.now() + IDEMPOTENCY_TTL_MS,
    });
    await ctx.storage.put({ [idemKey]: entry });
  } catch {
    // Idempotency cache is non-critical
  }

  safeLog.info('[CoordinatorExecute] Tool execution completed', {
    requestId: toolRequest.id,
    kind: result.kind,
    category: toolRequest.category,
  });
}

async function enqueueAsyncExecution(
  toolRequest: ToolRequest,
  computedRiskTier: number,
  requestUrl: string,
  ctx: CoordinatorExecuteContext,
): Promise<Response> {
  try {
    const payload = ExecutionTaskPayloadSchema.parse({
      requestId: toolRequest.id,
      toolName: toolRequest.name,
      category: toolRequest.category,
      params: toolRequest.params,
      effects: toolRequest.effects,
      computedRiskTier,
      traceContext: toolRequest.traceContext,
      idempotencyKey: toolRequest.idempotencyKey,
    });

    const task = createExecutionTask(
      'autopilot-system',
      payload,
      { priority: computedRiskTier >= 3 ? 'low' : 'medium' },
    );

    const currentQueue = ctx.getExecutionQueue();
    const { nextState, accepted } = enqueueExecution(currentQueue, task);
    if (!accepted) {
      return errorResponse('Execution queue full or duplicate', 429, 'QUEUE_FULL');
    }

    ctx.setExecutionQueue(nextState);
    await ctx.storage.put({ [`${EXEC_TASK_PREFIX}${task.id}`]: task });

    safeLog.info('[CoordinatorExecute] Async execution enqueued', {
      taskId: task.id,
      requestId: toolRequest.id,
    });

    const baseUrl = new URL(requestUrl).origin;
    const asyncResponse = createAsyncAcceptedResponse(task.id, baseUrl);
    return jsonResponse({ success: true, data: asyncResponse }, 202);
  } catch (err) {
    safeLog.error('[CoordinatorExecute] Async enqueue failed', {
      error: err instanceof Error ? err.message : String(err),
      requestId: toolRequest.id,
    });
    return errorResponse('Failed to enqueue async execution', 500, 'ENQUEUE_FAILED');
  }
}
