/**
 * Execution Queue — Dedicated queue for TOOL_EXECUTION tasks.
 *
 * Separated from autopilot-queue (system tasks) to prevent Head-of-Line
 * blocking between system health checks and user tool executions.
 *
 * Security: ownerId scoping, dequeue-time re-validation, async rate limiting.
 * All results are frozen. Fail-closed on errors.
 */

import { z } from 'zod';
import { safeLog } from '../../../utils/log-sanitizer';

// =============================================================================
// Constants
// =============================================================================

/** Soft timeout for sync execution before falling back to async (ms) */
export const SYNC_EXECUTION_TIMEOUT_MS = 25_000;

/** Maximum pending execution tasks per owner */
export const MAX_PENDING_PER_OWNER = 20;

/** Maximum concurrent in-flight executions */
export const MAX_IN_FLIGHT = 5;

/** Task result TTL (24h) */
export const TASK_RESULT_TTL_MS = 24 * 60 * 60 * 1000;

/** Storage key prefix for execution tasks */
export const EXEC_TASK_PREFIX = 'autopilot:exec-task:';

/** Storage key prefix for execution results */
export const EXEC_RESULT_PREFIX = 'autopilot:task-result:';

// =============================================================================
// Task Status FSM: PENDING → PROCESSING → COMPLETED | FAILED | EXPIRED
// =============================================================================

export const EXEC_TASK_STATUSES = [
  'PENDING',
  'PROCESSING',
  'COMPLETED',
  'FAILED',
  'EXPIRED',
] as const;

export type ExecTaskStatus = typeof EXEC_TASK_STATUSES[number];

// =============================================================================
// Execution Task Schema (stricter than generic AutopilotTask)
// =============================================================================

export const ExecutionTaskPayloadSchema = z.object({
  requestId: z.string().min(1).max(256),
  toolName: z.string().min(1).max(256),
  category: z.string().min(1).max(128),
  params: z.record(z.unknown()).refine(
    (obj) => Object.keys(obj).length <= 50,
    { message: 'params must have at most 50 keys' },
  ),
  effects: z.array(z.string().max(128)).max(10),
  computedRiskTier: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  traceContext: z.object({
    traceId: z.string().min(1).max(256),
    spanId: z.string().min(1).max(256),
    timestamp: z.string().min(1).max(256),
  }).strict(),
  idempotencyKey: z.string().min(1).max(256),
}).strict();

export type ExecutionTaskPayload = z.infer<typeof ExecutionTaskPayloadSchema>;

export interface ExecutionTask {
  readonly id: string;
  readonly ownerId: string;
  readonly payload: ExecutionTaskPayload;
  readonly status: ExecTaskStatus;
  readonly priority: 'critical' | 'high' | 'medium' | 'low';
  readonly createdAt: number;
  readonly retryCount: number;
  readonly maxRetries: number;
  readonly updatedAt: number;
}

// =============================================================================
// Execution Result
// =============================================================================

export interface ExecutionResult {
  readonly taskId: string;
  readonly ownerId: string;
  readonly status: 'completed' | 'failed';
  readonly data?: unknown;
  readonly error?: string;
  readonly errorCode?: string;
  readonly completedAt: number;
  readonly durationMs: number;
  readonly expiresAt: number;
}

// =============================================================================
// Queue State (in-memory, separate from system queue)
// =============================================================================

export interface ExecutionQueueState {
  readonly pending: readonly ExecutionTask[];
  readonly inFlight: number;
  readonly processedCount: number;
  readonly failedCount: number;
}

export function createExecutionQueueState(): ExecutionQueueState {
  return Object.freeze({
    pending: Object.freeze([]),
    inFlight: 0,
    processedCount: 0,
    failedCount: 0,
  });
}

// =============================================================================
// Pure Functions
// =============================================================================

let execTaskCounter = 0;

/**
 * Create a new execution task. Validates payload strictly.
 * Fail-closed: throws on invalid payload (caught by caller).
 */
export function createExecutionTask(
  ownerId: string,
  payload: ExecutionTaskPayload,
  options: {
    priority?: ExecutionTask['priority'];
    maxRetries?: number;
  } = {},
): ExecutionTask {
  // Validate payload (defense in depth — even if caller already validated)
  ExecutionTaskPayloadSchema.parse(payload);

  execTaskCounter += 1;
  const now = Date.now();
  const id = `exec-${now}-${execTaskCounter}`;

  return Object.freeze({
    id,
    ownerId,
    payload: Object.freeze(payload),
    status: 'PENDING' as const,
    priority: options.priority ?? 'medium',
    createdAt: now,
    retryCount: 0,
    maxRetries: options.maxRetries ?? 3,
    updatedAt: now,
  });
}

/**
 * Enqueue an execution task with owner-scoped rate limiting.
 * Returns null if the owner has too many pending tasks.
 */
export function enqueueExecution(
  state: ExecutionQueueState,
  task: ExecutionTask,
): { nextState: ExecutionQueueState; accepted: boolean } {
  // Owner rate limit: max pending tasks per owner
  const ownerPending = state.pending.filter((t) => t.ownerId === task.ownerId);
  if (ownerPending.length >= MAX_PENDING_PER_OWNER) {
    return { nextState: state, accepted: false };
  }

  // Idempotency dedup
  const exists = state.pending.some(
    (t) => t.payload.idempotencyKey === task.payload.idempotencyKey,
  );
  if (exists) {
    return { nextState: state, accepted: false };
  }

  // Priority insertion (same algorithm as autopilot-queue)
  const priorityOrder = { critical: 4, high: 3, medium: 2, low: 1 };
  const taskPriority = priorityOrder[task.priority] ?? 2;
  const newPending = [...state.pending];
  let insertIdx = newPending.length;
  for (let i = 0; i < newPending.length; i++) {
    const existingPriority = priorityOrder[newPending[i].priority] ?? 2;
    if (taskPriority > existingPriority) {
      insertIdx = i;
      break;
    }
  }
  newPending.splice(insertIdx, 0, task);

  return {
    nextState: Object.freeze({
      ...state,
      pending: Object.freeze(newPending),
    }),
    accepted: true,
  };
}

/**
 * Dequeue the next execution task for processing.
 * Respects maxInFlight concurrency limit.
 */
export function dequeueExecution(
  state: ExecutionQueueState,
): { task: ExecutionTask | null; nextState: ExecutionQueueState } {
  if (state.pending.length === 0 || state.inFlight >= MAX_IN_FLIGHT) {
    return { task: null, nextState: state };
  }

  const [task, ...rest] = state.pending;
  return {
    task,
    nextState: Object.freeze({
      ...state,
      pending: Object.freeze(rest),
      inFlight: state.inFlight + 1,
    }),
  };
}

/**
 * Mark an execution task as completed (success or failure).
 */
export function completeExecution(
  state: ExecutionQueueState,
  success: boolean,
): ExecutionQueueState {
  return Object.freeze({
    ...state,
    inFlight: Math.max(0, state.inFlight - 1),
    processedCount: success ? state.processedCount + 1 : state.processedCount,
    failedCount: success ? state.failedCount : state.failedCount + 1,
  });
}

/**
 * Retry an execution task (increment retryCount, re-enqueue).
 */
export function retryExecution(task: ExecutionTask): ExecutionTask {
  return Object.freeze({
    ...task,
    retryCount: task.retryCount + 1,
    status: 'PENDING' as const,
    updatedAt: Date.now(),
  });
}

export function canRetryExecution(task: ExecutionTask): boolean {
  return task.retryCount < task.maxRetries;
}

// =============================================================================
// Result Storage Helpers (for DO SQLite persistence)
// =============================================================================

/**
 * Create a frozen execution result for storage.
 */
export function createExecutionResult(
  taskId: string,
  ownerId: string,
  success: boolean,
  data: unknown,
  error: string | undefined,
  errorCode: string | undefined,
  durationMs: number,
): ExecutionResult {
  return Object.freeze({
    taskId,
    ownerId,
    status: success ? 'completed' as const : 'failed' as const,
    data: success ? data : undefined,
    error,
    errorCode,
    completedAt: Date.now(),
    durationMs,
    expiresAt: Date.now() + TASK_RESULT_TTL_MS,
  });
}

/**
 * Check if a result has expired.
 */
export function isResultExpired(result: ExecutionResult, nowMs: number): boolean {
  return nowMs >= result.expiresAt;
}

// =============================================================================
// Async Response (202 Accepted)
// =============================================================================

export interface AsyncAcceptedResponse {
  readonly taskId: string;
  readonly status: 'accepted';
  readonly statusUrl: string;
  readonly retryAfterMs: number;
}

export function createAsyncAcceptedResponse(
  taskId: string,
  baseUrl: string,
): AsyncAcceptedResponse {
  return Object.freeze({
    taskId,
    status: 'accepted' as const,
    statusUrl: `${baseUrl}/task/${taskId}`,
    retryAfterMs: 5000,
  });
}
