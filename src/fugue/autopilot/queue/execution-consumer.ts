/**
 * Execution Consumer — Processes TOOL_EXECUTION tasks from the dedicated queue.
 *
 * Extracted from AutopilotCoordinator to keep DO under 800 lines.
 * Receives dependencies via ExecutionContext interface (dependency injection).
 *
 * Security: re-validates policy at dequeue time (Defense in Depth).
 * Fail-closed: errors result in retry or DLQ.
 */

import type { PolicyContext, PolicyDecision } from '../policy/types';
import { evaluatePolicy } from '../policy/engine';
import { DEFAULT_RULES } from '../policy/rules';
import { BUDGET_STATES, ORIGINS, SUBJECT_TYPES, TRUST_ZONES } from '../types';
import type { TraceContext, TraceId, SpanId } from '../types/trace';
import { createTraceContext } from '../utils/trace';
import type { EffectType } from '../types';
import type { ToolRequest, ToolResult } from '../executor/types';
import { ToolResultKind } from '../executor/types';
import { createExecutorWorker, type ExecutorStorage } from '../executor/factory';
import type { ExtendedMode } from '../runtime/coordinator';
import { toLegacyMode } from '../runtime/coordinator';
import { safeLog } from '../../../utils/log-sanitizer';

import {
  type ExecutionQueueState,
  type ExecutionTask,
  dequeueExecution,
  enqueueExecution,
  completeExecution,
  retryExecution,
  canRetryExecution,
  createExecutionResult,
  EXEC_RESULT_PREFIX,
  EXEC_TASK_PREFIX,
} from './execution-queue';

// =============================================================================
// Dependency Injection Interface
// =============================================================================

export interface ExecutionConsumerContext {
  readonly extendedMode: ExtendedMode;
  readonly budgetSpent: number;
  readonly budgetLimit: number;
  readonly apiKeys: {
    readonly OPENAI_API_KEY?: string;
    readonly ZAI_API_KEY?: string;
    readonly GEMINI_API_KEY?: string;
  };
  readonly storage: ExecutorStorage;
  readonly doStorage: {
    put: (entries: Record<string, unknown>) => Promise<void>;
    delete: (key: string) => Promise<boolean>;
  };
  isOperational: () => boolean;
}

// =============================================================================
// Consumer
// =============================================================================

const MAX_BATCH_PER_TICK = 3;

/**
 * Process pending execution tasks. Returns updated queue state.
 * Pure-ish: mutates nothing except through doStorage side effects.
 */
export async function processExecutionBatch(
  queueState: ExecutionQueueState,
  ctx: ExecutionConsumerContext,
): Promise<ExecutionQueueState> {
  if (!ctx.isOperational()) return queueState;

  let currentState = queueState;
  let processed = 0;

  while (processed < MAX_BATCH_PER_TICK) {
    const { task, nextState } = dequeueExecution(currentState);
    if (!task) break;

    currentState = nextState;

    try {
      // Re-validate operational state (Defense in Depth)
      if (!ctx.isOperational()) {
        const { nextState: requeueState } = enqueueExecution(currentState, task);
        currentState = requeueState;
        break;
      }

      const { worker } = await createExecutorWorker({
        env: ctx.apiKeys,
        storage: ctx.storage,
        mode: toLegacyMode(ctx.extendedMode),
      });

      const startMs = Date.now();
      const toolRequest = buildToolRequest(task);
      const decision = computeDequeuePolicy(task, ctx);

      if (!decision.allowed) {
        const result = createExecutionResult(
          task.id, task.ownerId, false, undefined, decision.reason, 'POLICY_DENIED', 0,
        );
        await ctx.doStorage.put({ [`${EXEC_RESULT_PREFIX}${task.id}`]: result });
        await ctx.doStorage.delete(`${EXEC_TASK_PREFIX}${task.id}`);
        currentState = completeExecution(currentState, false);
        processed += 1;
        continue;
      }

      const toolResult = await worker.execute(toolRequest, decision);
      const durationMs = Date.now() - startMs;

      const isSuccess = toolResult.kind === ToolResultKind.SUCCESS;
      const result = createExecutionResult(
        task.id,
        task.ownerId,
        isSuccess,
        isSuccess ? toolResult : undefined,
        isSuccess ? undefined : extractError(toolResult),
        isSuccess ? undefined : extractErrorCode(toolResult),
        durationMs,
      );

      await ctx.doStorage.put({ [`${EXEC_RESULT_PREFIX}${task.id}`]: result });
      await ctx.doStorage.delete(`${EXEC_TASK_PREFIX}${task.id}`);
      currentState = completeExecution(currentState, isSuccess);

      safeLog.info('[ExecutionConsumer] Task completed', {
        taskId: task.id,
        success: isSuccess,
        durationMs,
      });
    } catch (err) {
      safeLog.error('[ExecutionConsumer] Task error', {
        taskId: task.id,
        error: err instanceof Error ? err.message : String(err),
      });

      if (canRetryExecution(task)) {
        const retried = retryExecution(task);
        const { nextState: requeueState } = enqueueExecution(currentState, retried);
        currentState = requeueState;
      } else {
        const result = createExecutionResult(
          task.id, task.ownerId, false, undefined,
          err instanceof Error ? err.message : 'unknown error', 'RETRY_EXHAUSTED', 0,
        );
        await ctx.doStorage.put({ [`${EXEC_RESULT_PREFIX}${task.id}`]: result });
        await ctx.doStorage.delete(`${EXEC_TASK_PREFIX}${task.id}`);
        currentState = completeExecution(currentState, false);
      }
    }

    processed += 1;
  }

  return currentState;
}

// =============================================================================
// Helpers
// =============================================================================

function coerceTraceContext(value: unknown): TraceContext {
  const v = value as any;
  if (v && typeof v === 'object') {
    const traceId = typeof v.traceId === 'string' ? (v.traceId as TraceId) : null;
    const spanId = typeof v.spanId === 'string' ? (v.spanId as SpanId) : null;
    const timestamp = typeof v.timestamp === 'string' ? v.timestamp : null;
    const parentSpanId = typeof v.parentSpanId === 'string' ? (v.parentSpanId as SpanId) : undefined;
    if (traceId && spanId && timestamp) {
      return Object.freeze({ traceId, spanId, timestamp, ...(parentSpanId ? { parentSpanId } : {}) });
    }
  }

  // Fail-soft: trace context is for correlation only.
  return createTraceContext();
}

function buildToolRequest(task: ExecutionTask): ToolRequest {
  return {
    id: task.payload.requestId,
    name: task.payload.toolName,
    category: task.payload.category,
    params: task.payload.params,
    effects: task.payload.effects,
    riskTier: task.payload.computedRiskTier,
    traceContext: coerceTraceContext(task.payload.traceContext),
    attempt: task.retryCount + 1,
    maxAttempts: task.maxRetries + 1,
    requestedAt: new Date(task.createdAt).toISOString(),
    idempotencyKey: task.payload.idempotencyKey,
  } as unknown as ToolRequest;
}

function computeDequeuePolicy(
  task: ExecutionTask,
  ctx: ExecutionConsumerContext,
): PolicyDecision {
  const budgetState = ctx.budgetSpent >= ctx.budgetLimit
    ? BUDGET_STATES.HALTED
    : ctx.budgetSpent >= ctx.budgetLimit * 0.8
      ? BUDGET_STATES.DEGRADED
      : BUDGET_STATES.NORMAL;

  const policyCtx: PolicyContext = {
    subject: { id: 'autopilot-system', type: SUBJECT_TYPES.SYSTEM },
    origin: ORIGINS.INTERNAL,
    effects: task.payload.effects as readonly EffectType[],
    riskTier: task.payload.computedRiskTier,
    trustZone: TRUST_ZONES.TRUSTED_CONFIG,
    budgetState,
    traceContext: coerceTraceContext(task.payload.traceContext),
  };

  return evaluatePolicy(policyCtx, DEFAULT_RULES, []);
}

function extractError(result: ToolResult): string {
  if ('error' in result && result.error) return String(result.error);
  return 'execution failed';
}

function extractErrorCode(result: ToolResult): string {
  if ('errorCode' in result && result.errorCode) return String(result.errorCode);
  return 'EXECUTION_FAILED';
}
