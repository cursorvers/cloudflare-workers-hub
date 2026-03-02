/**
 * Autopilot Queue Abstraction
 *
 * Provides a unified interface for async task processing.
 * Primary: Direct DO dispatch (free plan compatible).
 * Future: CF Queue binding when available.
 *
 * Task types: GUARD_CHECK, BUDGET_UPDATE, NOTIFICATION, AUDIT_LOG
 */

import { z } from 'zod';
import type { Env } from '../../../types';
import { safeLog } from '../../../utils/log-sanitizer';
import { doFetch } from '../../../utils/do-fetch';

// =============================================================================
// Task Types & Validation
// =============================================================================

export const AUTOPILOT_TASK_TYPES = [
  'GUARD_CHECK',
  'BUDGET_UPDATE',
  'NOTIFICATION',
  'AUDIT_LOG',
] as const;

export type AutopilotTaskType = typeof AUTOPILOT_TASK_TYPES[number];

export const AutopilotTaskSchema = z.object({
  id: z.string().min(1),
  type: z.enum(AUTOPILOT_TASK_TYPES),
  payload: z.record(z.unknown()),
  priority: z.enum(['critical', 'high', 'medium', 'low']).default('medium'),
  createdAt: z.number(),
  retryCount: z.number().int().min(0).default(0),
  maxRetries: z.number().int().min(0).default(3),
  idempotencyKey: z.string().optional(),
});

export type AutopilotTask = z.infer<typeof AutopilotTaskSchema>;

// =============================================================================
// Task Result
// =============================================================================

export interface AutopilotTaskResult {
  readonly taskId: string;
  readonly type: AutopilotTaskType;
  readonly success: boolean;
  readonly data?: unknown;
  readonly error?: string;
  readonly processedAt: number;
  readonly durationMs: number;
}

// =============================================================================
// Dead Letter Entry
// =============================================================================

export interface DeadLetterEntry {
  readonly task: AutopilotTask;
  readonly lastError: string;
  readonly failedAt: number;
  readonly totalAttempts: number;
}

// =============================================================================
// Queue State (in-memory for DO-based queue)
// =============================================================================

export interface QueueState {
  readonly pending: readonly AutopilotTask[];
  readonly deadLetter: readonly DeadLetterEntry[];
  readonly processedCount: number;
  readonly failedCount: number;
}

export function createQueueState(): QueueState {
  return Object.freeze({
    pending: Object.freeze([]),
    deadLetter: Object.freeze([]),
    processedCount: 0,
    failedCount: 0,
  });
}

// =============================================================================
// Pure Functions: Enqueue / Dequeue / Move to DLQ
// =============================================================================

export function enqueue(state: QueueState, task: AutopilotTask): QueueState {
  // Deduplicate by idempotencyKey
  if (task.idempotencyKey) {
    const exists = state.pending.some(
      (t) => t.idempotencyKey === task.idempotencyKey,
    );
    if (exists) return state;
  }

  // Priority insertion: critical > high > medium > low
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

  return Object.freeze({
    ...state,
    pending: Object.freeze(newPending),
  });
}

export function dequeue(state: QueueState): { task: AutopilotTask | null; nextState: QueueState } {
  if (state.pending.length === 0) {
    return { task: null, nextState: state };
  }

  const [task, ...rest] = state.pending;
  return {
    task,
    nextState: Object.freeze({
      ...state,
      pending: Object.freeze(rest),
    }),
  };
}

export function markProcessed(state: QueueState): QueueState {
  return Object.freeze({
    ...state,
    processedCount: state.processedCount + 1,
  });
}

export function moveToDeadLetter(
  state: QueueState,
  task: AutopilotTask,
  error: string,
  nowMs: number,
): QueueState {
  const entry: DeadLetterEntry = Object.freeze({
    task,
    lastError: error,
    failedAt: nowMs,
    totalAttempts: task.retryCount + 1,
  });

  return Object.freeze({
    ...state,
    deadLetter: Object.freeze([...state.deadLetter, entry]),
    failedCount: state.failedCount + 1,
  });
}

export function retryTask(task: AutopilotTask): AutopilotTask {
  return Object.freeze({
    ...task,
    retryCount: task.retryCount + 1,
  });
}

export function canRetry(task: AutopilotTask): boolean {
  return task.retryCount < task.maxRetries;
}

// =============================================================================
// Task Factory
// =============================================================================

let taskCounter = 0;

export function createTask(
  type: AutopilotTaskType,
  payload: Record<string, unknown>,
  options: {
    priority?: AutopilotTask['priority'];
    maxRetries?: number;
    idempotencyKey?: string;
  } = {},
): AutopilotTask {
  taskCounter += 1;
  const now = Date.now();
  const id = `autopilot-${now}-${taskCounter}`;

  const raw = {
    id,
    type,
    payload,
    priority: options.priority ?? 'medium',
    createdAt: now,
    retryCount: 0,
    maxRetries: options.maxRetries ?? 3,
    idempotencyKey: options.idempotencyKey,
  };

  return Object.freeze(AutopilotTaskSchema.parse(raw));
}

// =============================================================================
// DO-based Dispatch (Primary — free plan compatible)
// =============================================================================

const TASK_TO_DO_PATH: Record<AutopilotTaskType, string> = {
  GUARD_CHECK: '/heartbeat',
  BUDGET_UPDATE: '/budget',
  NOTIFICATION: '/status',
  AUDIT_LOG: '/status',
};

export async function dispatchToDO(
  env: Env,
  task: AutopilotTask,
): Promise<AutopilotTaskResult> {
  const startMs = Date.now();

  if (!env.AUTOPILOT_COORDINATOR) {
    return Object.freeze({
      taskId: task.id,
      type: task.type,
      success: false,
      error: 'AUTOPILOT_COORDINATOR binding not available',
      processedAt: startMs,
      durationMs: 0,
    });
  }

  try {
    const doPath = TASK_TO_DO_PATH[task.type];
    const id = env.AUTOPILOT_COORDINATOR.idFromName('autopilot');
    const stub = env.AUTOPILOT_COORDINATOR.get(id);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (env.AUTOPILOT_API_KEY) {
      headers['Authorization'] = `Bearer ${env.AUTOPILOT_API_KEY}`;
    }

    const method = task.type === 'GUARD_CHECK' ? 'POST' : 'POST';
    const response = await doFetch(stub, `https://autopilot-do${doPath}`, {
      method,
      headers,
      body: JSON.stringify(task.payload),
    });

    const data = await response.json().catch(() => null);
    const endMs = Date.now();

    return Object.freeze({
      taskId: task.id,
      type: task.type,
      success: response.ok,
      data,
      error: response.ok ? undefined : `DO returned ${response.status}`,
      processedAt: endMs,
      durationMs: endMs - startMs,
    });
  } catch (err) {
    const endMs = Date.now();
    return Object.freeze({
      taskId: task.id,
      type: task.type,
      success: false,
      error: err instanceof Error ? err.message : String(err),
      processedAt: endMs,
      durationMs: endMs - startMs,
    });
  }
}

// =============================================================================
// Process Single Task (with retry + DLQ)
// =============================================================================

export async function processTask(
  env: Env,
  task: AutopilotTask,
  state: QueueState,
): Promise<{ result: AutopilotTaskResult; nextState: QueueState }> {
  const result = await dispatchToDO(env, task);

  if (result.success) {
    return {
      result,
      nextState: markProcessed(state),
    };
  }

  // Retry or DLQ
  if (canRetry(task)) {
    const retried = retryTask(task);
    safeLog.warn('[AutopilotQueue] Task failed, retrying', {
      taskId: task.id,
      type: task.type,
      retryCount: retried.retryCount,
      error: result.error,
    });
    return {
      result,
      nextState: enqueue(state, retried),
    };
  }

  // Move to dead letter
  safeLog.error('[AutopilotQueue] Task exhausted retries, moving to DLQ', {
    taskId: task.id,
    type: task.type,
    totalAttempts: task.retryCount + 1,
    error: result.error,
  });

  return {
    result,
    nextState: moveToDeadLetter(state, task, result.error ?? 'unknown', Date.now()),
  };
}

// =============================================================================
// Batch Processing
// =============================================================================

export async function processBatch(
  env: Env,
  state: QueueState,
  maxBatchSize = 10,
): Promise<{ results: readonly AutopilotTaskResult[]; nextState: QueueState }> {
  const results: AutopilotTaskResult[] = [];
  let currentState = state;
  let processed = 0;

  while (processed < maxBatchSize) {
    const { task, nextState } = dequeue(currentState);
    if (!task) break;

    currentState = nextState;
    const { result, nextState: afterProcess } = await processTask(env, task, currentState);
    currentState = afterProcess;
    results.push(result);
    processed += 1;
  }

  return {
    results: Object.freeze(results),
    nextState: currentState,
  };
}
