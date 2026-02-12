import { describe, expect, it } from 'vitest';

import {
  createExecutionQueueState,
  createExecutionTask,
  enqueueExecution,
  dequeueExecution,
  completeExecution,
  retryExecution,
  canRetryExecution,
  createExecutionResult,
  createAsyncAcceptedResponse,
  isResultExpired,
  MAX_PENDING_PER_OWNER,
  MAX_IN_FLIGHT,
  TASK_RESULT_TTL_MS,
  SYNC_EXECUTION_TIMEOUT_MS,
  type ExecutionTaskPayload,
  type ExecutionTask,
} from '../execution-queue';

// =============================================================================
// Helpers
// =============================================================================

function validPayload(overrides: Partial<ExecutionTaskPayload> = {}): ExecutionTaskPayload {
  return {
    requestId: 'req-1',
    toolName: 'test-tool',
    category: 'CODE_EXECUTION',
    params: { key: 'value' },
    effects: ['FILE_SYSTEM_WRITE'],
    computedRiskTier: 2,
    traceContext: { traceId: 'trace-1', spanId: 'span-1', timestamp: new Date().toISOString() },
    idempotencyKey: `idem-${Date.now()}-${Math.random()}`,
    ...overrides,
  };
}

// =============================================================================
// Phase 4: Execution Queue Tests
// =============================================================================

describe('Phase 4: execution-queue', () => {
  // =========================================================================
  // Queue State
  // =========================================================================

  describe('createExecutionQueueState', () => {
    it('creates empty frozen state', () => {
      const state = createExecutionQueueState();
      expect(state.pending).toEqual([]);
      expect(state.inFlight).toBe(0);
      expect(state.processedCount).toBe(0);
      expect(state.failedCount).toBe(0);
      expect(Object.isFrozen(state)).toBe(true);
    });
  });

  // =========================================================================
  // Task Creation
  // =========================================================================

  describe('createExecutionTask', () => {
    it('creates a frozen task with PENDING status', () => {
      const payload = validPayload();
      const task = createExecutionTask('owner-1', payload);

      expect(task.id).toMatch(/^exec-/);
      expect(task.ownerId).toBe('owner-1');
      expect(task.status).toBe('PENDING');
      expect(task.priority).toBe('medium');
      expect(task.retryCount).toBe(0);
      expect(task.maxRetries).toBe(3);
      expect(Object.isFrozen(task)).toBe(true);
      expect(Object.isFrozen(task.payload)).toBe(true);
    });

    it('respects custom priority and maxRetries', () => {
      const task = createExecutionTask('owner-1', validPayload(), {
        priority: 'critical',
        maxRetries: 5,
      });
      expect(task.priority).toBe('critical');
      expect(task.maxRetries).toBe(5);
    });

    it('rejects invalid payload (defense in depth)', () => {
      expect(() => {
        createExecutionTask('owner-1', { invalid: true } as unknown as ExecutionTaskPayload);
      }).toThrow();
    });

    it('rejects payload with too many params keys', () => {
      const bigParams: Record<string, unknown> = {};
      for (let i = 0; i < 51; i++) {
        bigParams[`key${i}`] = i;
      }
      expect(() => {
        createExecutionTask('owner-1', validPayload({ params: bigParams }));
      }).toThrow(/at most 50 keys/);
    });
  });

  // =========================================================================
  // Enqueue
  // =========================================================================

  describe('enqueueExecution', () => {
    it('accepts task and adds to pending', () => {
      const state = createExecutionQueueState();
      const task = createExecutionTask('owner-1', validPayload());
      const { nextState, accepted } = enqueueExecution(state, task);

      expect(accepted).toBe(true);
      expect(nextState.pending).toHaveLength(1);
      expect(Object.isFrozen(nextState)).toBe(true);
    });

    it('rejects when owner exceeds MAX_PENDING_PER_OWNER', () => {
      let state = createExecutionQueueState();
      for (let i = 0; i < MAX_PENDING_PER_OWNER; i++) {
        const task = createExecutionTask('owner-1', validPayload({
          idempotencyKey: `idem-${i}`,
        }));
        const result = enqueueExecution(state, task);
        state = result.nextState;
      }

      // One more should be rejected
      const extraTask = createExecutionTask('owner-1', validPayload({
        idempotencyKey: 'idem-extra',
      }));
      const { accepted } = enqueueExecution(state, extraTask);
      expect(accepted).toBe(false);
    });

    it('allows different owners to enqueue independently', () => {
      let state = createExecutionQueueState();
      for (let i = 0; i < MAX_PENDING_PER_OWNER; i++) {
        const task = createExecutionTask('owner-1', validPayload({
          idempotencyKey: `owner1-${i}`,
        }));
        state = enqueueExecution(state, task).nextState;
      }

      // Different owner should succeed
      const task2 = createExecutionTask('owner-2', validPayload({
        idempotencyKey: 'owner2-0',
      }));
      const { accepted } = enqueueExecution(state, task2);
      expect(accepted).toBe(true);
    });

    it('deduplicates by idempotencyKey', () => {
      const state = createExecutionQueueState();
      const task1 = createExecutionTask('owner-1', validPayload({
        idempotencyKey: 'same-key',
      }));
      const { nextState } = enqueueExecution(state, task1);

      const task2 = createExecutionTask('owner-1', validPayload({
        idempotencyKey: 'same-key',
      }));
      const { nextState: state2, accepted } = enqueueExecution(nextState, task2);

      expect(accepted).toBe(false);
      expect(state2.pending).toHaveLength(1);
    });

    it('priority insertion: critical before medium', () => {
      let state = createExecutionQueueState();
      const low = createExecutionTask('owner-1', validPayload({ idempotencyKey: 'low' }), { priority: 'low' });
      const critical = createExecutionTask('owner-1', validPayload({ idempotencyKey: 'crit' }), { priority: 'critical' });

      state = enqueueExecution(state, low).nextState;
      state = enqueueExecution(state, critical).nextState;

      expect(state.pending[0].priority).toBe('critical');
      expect(state.pending[1].priority).toBe('low');
    });
  });

  // =========================================================================
  // Dequeue
  // =========================================================================

  describe('dequeueExecution', () => {
    it('returns null for empty queue', () => {
      const state = createExecutionQueueState();
      const { task } = dequeueExecution(state);
      expect(task).toBeNull();
    });

    it('dequeues first task and increments inFlight', () => {
      let state = createExecutionQueueState();
      const task = createExecutionTask('owner-1', validPayload());
      state = enqueueExecution(state, task).nextState;

      const { task: dequeued, nextState } = dequeueExecution(state);
      expect(dequeued).not.toBeNull();
      expect(dequeued!.ownerId).toBe('owner-1');
      expect(nextState.pending).toHaveLength(0);
      expect(nextState.inFlight).toBe(1);
    });

    it('respects MAX_IN_FLIGHT concurrency limit', () => {
      let state = createExecutionQueueState();
      // Enqueue more than MAX_IN_FLIGHT tasks
      for (let i = 0; i < MAX_IN_FLIGHT + 2; i++) {
        const task = createExecutionTask('owner-1', validPayload({
          idempotencyKey: `task-${i}`,
        }));
        state = enqueueExecution(state, task).nextState;
      }

      // Dequeue up to MAX_IN_FLIGHT
      for (let i = 0; i < MAX_IN_FLIGHT; i++) {
        const result = dequeueExecution(state);
        expect(result.task).not.toBeNull();
        state = result.nextState;
      }

      // Next dequeue should return null (at capacity)
      const { task } = dequeueExecution(state);
      expect(task).toBeNull();
      expect(state.inFlight).toBe(MAX_IN_FLIGHT);
    });
  });

  // =========================================================================
  // Complete / Retry
  // =========================================================================

  describe('completeExecution', () => {
    it('decrements inFlight and increments processedCount on success', () => {
      const state: ReturnType<typeof createExecutionQueueState> = Object.freeze({
        pending: Object.freeze([]),
        inFlight: 2,
        processedCount: 5,
        failedCount: 1,
      });
      const next = completeExecution(state, true);
      expect(next.inFlight).toBe(1);
      expect(next.processedCount).toBe(6);
      expect(next.failedCount).toBe(1);
    });

    it('decrements inFlight and increments failedCount on failure', () => {
      const state: ReturnType<typeof createExecutionQueueState> = Object.freeze({
        pending: Object.freeze([]),
        inFlight: 1,
        processedCount: 5,
        failedCount: 2,
      });
      const next = completeExecution(state, false);
      expect(next.inFlight).toBe(0);
      expect(next.processedCount).toBe(5);
      expect(next.failedCount).toBe(3);
    });

    it('inFlight never goes below 0', () => {
      const state = createExecutionQueueState();
      const next = completeExecution(state, true);
      expect(next.inFlight).toBe(0);
    });
  });

  describe('retryExecution', () => {
    it('increments retryCount and resets status to PENDING', () => {
      const task = createExecutionTask('owner-1', validPayload());
      const retried = retryExecution(task);
      expect(retried.retryCount).toBe(1);
      expect(retried.status).toBe('PENDING');
      expect(Object.isFrozen(retried)).toBe(true);
    });
  });

  describe('canRetryExecution', () => {
    it('returns true when retries remain', () => {
      const task = createExecutionTask('owner-1', validPayload(), { maxRetries: 3 });
      expect(canRetryExecution(task)).toBe(true);
    });

    it('returns false when retries exhausted', () => {
      let task = createExecutionTask('owner-1', validPayload(), { maxRetries: 1 });
      task = retryExecution(task);
      expect(canRetryExecution(task)).toBe(false);
    });
  });

  // =========================================================================
  // Execution Result
  // =========================================================================

  describe('createExecutionResult', () => {
    it('creates a frozen success result', () => {
      const result = createExecutionResult(
        'task-1', 'owner-1', true, { output: 'done' }, undefined, undefined, 100,
      );
      expect(result.status).toBe('completed');
      expect(result.data).toEqual({ output: 'done' });
      expect(result.error).toBeUndefined();
      expect(result.durationMs).toBe(100);
      expect(result.expiresAt).toBeGreaterThan(Date.now());
      expect(Object.isFrozen(result)).toBe(true);
    });

    it('creates a frozen failure result', () => {
      const result = createExecutionResult(
        'task-2', 'owner-1', false, undefined, 'timeout', 'TIMEOUT', 5000,
      );
      expect(result.status).toBe('failed');
      expect(result.data).toBeUndefined();
      expect(result.error).toBe('timeout');
      expect(result.errorCode).toBe('TIMEOUT');
    });
  });

  describe('isResultExpired', () => {
    it('returns false when within TTL', () => {
      const result = createExecutionResult('t1', 'o1', true, {}, undefined, undefined, 0);
      expect(isResultExpired(result, Date.now())).toBe(false);
    });

    it('returns true when past TTL', () => {
      const result = createExecutionResult('t1', 'o1', true, {}, undefined, undefined, 0);
      expect(isResultExpired(result, Date.now() + TASK_RESULT_TTL_MS + 1000)).toBe(true);
    });
  });

  // =========================================================================
  // Async Response
  // =========================================================================

  describe('createAsyncAcceptedResponse', () => {
    it('creates a frozen 202 response with statusUrl', () => {
      const response = createAsyncAcceptedResponse('task-123', 'https://api.example.com');
      expect(response.taskId).toBe('task-123');
      expect(response.status).toBe('accepted');
      expect(response.statusUrl).toBe('https://api.example.com/task/task-123');
      expect(response.retryAfterMs).toBe(5000);
      expect(Object.isFrozen(response)).toBe(true);
    });
  });

  // =========================================================================
  // Constants
  // =========================================================================

  describe('constants', () => {
    it('SYNC_EXECUTION_TIMEOUT_MS is 25s', () => {
      expect(SYNC_EXECUTION_TIMEOUT_MS).toBe(25_000);
    });

    it('MAX_PENDING_PER_OWNER is 20', () => {
      expect(MAX_PENDING_PER_OWNER).toBe(20);
    });

    it('MAX_IN_FLIGHT is 5', () => {
      expect(MAX_IN_FLIGHT).toBe(5);
    });

    it('TASK_RESULT_TTL_MS is 24h', () => {
      expect(TASK_RESULT_TTL_MS).toBe(24 * 60 * 60 * 1000);
    });
  });

  // =========================================================================
  // Immutability (all state frozen)
  // =========================================================================

  describe('immutability', () => {
    it('all queue state transitions produce frozen objects', () => {
      let state = createExecutionQueueState();
      expect(Object.isFrozen(state)).toBe(true);

      const task = createExecutionTask('owner-1', validPayload());
      expect(Object.isFrozen(task)).toBe(true);

      const { nextState } = enqueueExecution(state, task);
      expect(Object.isFrozen(nextState)).toBe(true);
      expect(Object.isFrozen(nextState.pending)).toBe(true);

      const { nextState: afterDequeue } = dequeueExecution(nextState);
      expect(Object.isFrozen(afterDequeue)).toBe(true);

      const afterComplete = completeExecution(afterDequeue, true);
      expect(Object.isFrozen(afterComplete)).toBe(true);
    });
  });
});
