import { describe, expect, it, vi, beforeEach } from 'vitest';

import {
  AutopilotTaskSchema,
  AUTOPILOT_TASK_TYPES,
  createQueueState,
  createTask,
  enqueue,
  dequeue,
  markProcessed,
  moveToDeadLetter,
  retryTask,
  canRetry,
  dispatchToDO,
  processTask,
  processBatch,
  type AutopilotTask,
  type QueueState,
} from '../autopilot-queue';
import type { Env } from '../../../../types';

function mockEnv(overrides: Partial<Env> = {}): Env {
  const fetchSpy = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
  return {
    AI: {} as Ai,
    ENVIRONMENT: 'test',
    AUTOPILOT_API_KEY: 'test-key',
    AUTOPILOT_COORDINATOR: {
      idFromName: vi.fn().mockReturnValue('autopilot-id'),
      get: vi.fn().mockReturnValue({ fetch: fetchSpy }),
    } as unknown as DurableObjectNamespace,
    ...overrides,
  };
}

describe('fugue/autopilot/queue/autopilot-queue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // =========================================================================
  // Schema Validation
  // =========================================================================

  describe('AutopilotTaskSchema', () => {
    it('validates a correct task', () => {
      const raw = {
        id: 'task-1',
        type: 'GUARD_CHECK',
        payload: { key: 'value' },
        priority: 'high',
        createdAt: Date.now(),
        retryCount: 0,
        maxRetries: 3,
      };
      const result = AutopilotTaskSchema.parse(raw);
      expect(result.type).toBe('GUARD_CHECK');
      expect(result.priority).toBe('high');
    });

    it('rejects invalid task type', () => {
      const raw = {
        id: 'task-1',
        type: 'INVALID_TYPE',
        payload: {},
        createdAt: Date.now(),
        retryCount: 0,
      };
      expect(() => AutopilotTaskSchema.parse(raw)).toThrow();
    });

    it('applies defaults for priority and maxRetries', () => {
      const raw = {
        id: 'task-2',
        type: 'AUDIT_LOG',
        payload: {},
        createdAt: Date.now(),
        retryCount: 0,
      };
      const result = AutopilotTaskSchema.parse(raw);
      expect(result.priority).toBe('medium');
      expect(result.maxRetries).toBe(3);
    });
  });

  // =========================================================================
  // Pure Queue Functions
  // =========================================================================

  describe('Queue State Management', () => {
    it('creates empty initial state', () => {
      const state = createQueueState();
      expect(state.pending).toEqual([]);
      expect(state.deadLetter).toEqual([]);
      expect(state.processedCount).toBe(0);
      expect(state.failedCount).toBe(0);
      expect(Object.isFrozen(state)).toBe(true);
    });

    it('enqueue adds task to pending', () => {
      const state = createQueueState();
      const task = createTask('GUARD_CHECK', { check: true });
      const next = enqueue(state, task);

      expect(next.pending).toHaveLength(1);
      expect(next.pending[0].type).toBe('GUARD_CHECK');
      expect(Object.isFrozen(next)).toBe(true);
    });

    it('enqueue respects priority ordering', () => {
      let state = createQueueState();
      const low = createTask('AUDIT_LOG', {}, { priority: 'low' });
      const critical = createTask('GUARD_CHECK', {}, { priority: 'critical' });
      const medium = createTask('BUDGET_UPDATE', {}, { priority: 'medium' });

      state = enqueue(state, low);
      state = enqueue(state, medium);
      state = enqueue(state, critical);

      expect(state.pending[0].priority).toBe('critical');
      expect(state.pending[1].priority).toBe('medium');
      expect(state.pending[2].priority).toBe('low');
    });

    it('enqueue deduplicates by idempotencyKey', () => {
      let state = createQueueState();
      const t1 = createTask('AUDIT_LOG', { v: 1 }, { idempotencyKey: 'key-1' });
      const t2 = createTask('AUDIT_LOG', { v: 2 }, { idempotencyKey: 'key-1' });

      state = enqueue(state, t1);
      state = enqueue(state, t2);

      expect(state.pending).toHaveLength(1);
      expect((state.pending[0].payload as { v: number }).v).toBe(1);
    });

    it('dequeue returns null for empty queue', () => {
      const state = createQueueState();
      const { task, nextState } = dequeue(state);
      expect(task).toBeNull();
      expect(nextState).toBe(state);
    });

    it('dequeue returns first task and removes it', () => {
      let state = createQueueState();
      const t1 = createTask('GUARD_CHECK', { a: 1 });
      const t2 = createTask('BUDGET_UPDATE', { b: 2 });
      state = enqueue(state, t1);
      state = enqueue(state, t2);

      const { task, nextState } = dequeue(state);
      expect(task).not.toBeNull();
      expect(task!.type).toBe('GUARD_CHECK');
      expect(nextState.pending).toHaveLength(1);
    });

    it('markProcessed increments counter', () => {
      const state = createQueueState();
      const next = markProcessed(state);
      expect(next.processedCount).toBe(1);
      expect(Object.isFrozen(next)).toBe(true);
    });

    it('moveToDeadLetter adds entry and increments failedCount', () => {
      const state = createQueueState();
      const task = createTask('NOTIFICATION', { msg: 'test' });
      const next = moveToDeadLetter(state, task, 'timeout', 1000);

      expect(next.deadLetter).toHaveLength(1);
      expect(next.deadLetter[0].lastError).toBe('timeout');
      expect(next.failedCount).toBe(1);
      expect(Object.isFrozen(next)).toBe(true);
    });
  });

  // =========================================================================
  // Retry Logic
  // =========================================================================

  describe('Retry Logic', () => {
    it('canRetry returns true when retryCount < maxRetries', () => {
      const task = createTask('GUARD_CHECK', {}, { maxRetries: 3 });
      expect(canRetry(task)).toBe(true);
    });

    it('canRetry returns false when retryCount >= maxRetries', () => {
      const task = { ...createTask('GUARD_CHECK', {}, { maxRetries: 2 }), retryCount: 2 };
      expect(canRetry(task as AutopilotTask)).toBe(false);
    });

    it('retryTask increments retryCount', () => {
      const task = createTask('GUARD_CHECK', {});
      const retried = retryTask(task);
      expect(retried.retryCount).toBe(1);
      expect(Object.isFrozen(retried)).toBe(true);
    });
  });

  // =========================================================================
  // DO Dispatch
  // =========================================================================

  describe('dispatchToDO', () => {
    it('dispatches to AUTOPILOT_COORDINATOR DO', async () => {
      const env = mockEnv();
      const task = createTask('GUARD_CHECK', { check: true });
      const result = await dispatchToDO(env, task);

      expect(result.success).toBe(true);
      expect(result.type).toBe('GUARD_CHECK');
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(Object.isFrozen(result)).toBe(true);
    });

    it('returns error when AUTOPILOT_COORDINATOR is not available', async () => {
      const env = mockEnv({ AUTOPILOT_COORDINATOR: undefined });
      const task = createTask('BUDGET_UPDATE', { spent: 100, limit: 200 });
      const result = await dispatchToDO(env, task);

      expect(result.success).toBe(false);
      expect(result.error).toContain('not available');
    });

    it('handles DO fetch errors gracefully', async () => {
      const fetchSpy = vi.fn().mockRejectedValue(new Error('Network error'));
      const env = mockEnv({
        AUTOPILOT_COORDINATOR: {
          idFromName: vi.fn().mockReturnValue('id'),
          get: vi.fn().mockReturnValue({ fetch: fetchSpy }),
        } as unknown as DurableObjectNamespace,
      });
      const task = createTask('NOTIFICATION', { msg: 'alert' });
      const result = await dispatchToDO(env, task);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Network error');
    });
  });

  // =========================================================================
  // processTask (integration: dispatch + retry/DLQ)
  // =========================================================================

  describe('processTask', () => {
    it('marks state as processed on success', async () => {
      const env = mockEnv();
      const task = createTask('GUARD_CHECK', {});
      const state = createQueueState();
      const { result, nextState } = await processTask(env, task, state);

      expect(result.success).toBe(true);
      expect(nextState.processedCount).toBe(1);
    });

    it('retries on failure when retries remain', async () => {
      const fetchSpy = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'fail' }), { status: 500 }),
      );
      const env = mockEnv({
        AUTOPILOT_COORDINATOR: {
          idFromName: vi.fn().mockReturnValue('id'),
          get: vi.fn().mockReturnValue({ fetch: fetchSpy }),
        } as unknown as DurableObjectNamespace,
      });
      const task = createTask('BUDGET_UPDATE', {}, { maxRetries: 2 });
      const state = createQueueState();
      const { result, nextState } = await processTask(env, task, state);

      expect(result.success).toBe(false);
      expect(nextState.pending).toHaveLength(1);
      expect(nextState.pending[0].retryCount).toBe(1);
    });

    it('moves to DLQ when retries exhausted', async () => {
      const fetchSpy = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'fail' }), { status: 500 }),
      );
      const env = mockEnv({
        AUTOPILOT_COORDINATOR: {
          idFromName: vi.fn().mockReturnValue('id'),
          get: vi.fn().mockReturnValue({ fetch: fetchSpy }),
        } as unknown as DurableObjectNamespace,
      });
      const task = { ...createTask('NOTIFICATION', {}, { maxRetries: 0 }) };
      const state = createQueueState();
      const { result, nextState } = await processTask(env, task, state);

      expect(result.success).toBe(false);
      expect(nextState.deadLetter).toHaveLength(1);
      expect(nextState.failedCount).toBe(1);
    });
  });

  // =========================================================================
  // processBatch
  // =========================================================================

  describe('processBatch', () => {
    it('processes multiple tasks in order', async () => {
      const env = mockEnv();
      let state = createQueueState();
      state = enqueue(state, createTask('GUARD_CHECK', { a: 1 }));
      state = enqueue(state, createTask('BUDGET_UPDATE', { b: 2 }));
      state = enqueue(state, createTask('AUDIT_LOG', { c: 3 }));

      const { results, nextState } = await processBatch(env, state);

      expect(results).toHaveLength(3);
      expect(nextState.pending).toHaveLength(0);
      expect(nextState.processedCount).toBe(3);
    });

    it('respects maxBatchSize', async () => {
      const env = mockEnv();
      let state = createQueueState();
      for (let i = 0; i < 5; i++) {
        state = enqueue(state, createTask('AUDIT_LOG', { i }));
      }

      const { results, nextState } = await processBatch(env, state, 2);

      expect(results).toHaveLength(2);
      expect(nextState.pending).toHaveLength(3);
    });

    it('returns empty results for empty queue', async () => {
      const env = mockEnv();
      const state = createQueueState();
      const { results, nextState } = await processBatch(env, state);

      expect(results).toHaveLength(0);
      expect(nextState).toBe(state);
    });
  });

  // =========================================================================
  // Task Types
  // =========================================================================

  describe('Task Types', () => {
    it('exports all 4 task types', () => {
      expect(AUTOPILOT_TASK_TYPES).toEqual([
        'GUARD_CHECK',
        'BUDGET_UPDATE',
        'NOTIFICATION',
        'AUDIT_LOG',
      ]);
    });
  });

  // =========================================================================
  // Immutability
  // =========================================================================

  describe('Immutability', () => {
    it('all state objects are frozen', () => {
      const state = createQueueState();
      expect(Object.isFrozen(state)).toBe(true);

      const task = createTask('GUARD_CHECK', {});
      expect(Object.isFrozen(task)).toBe(true);

      const next = enqueue(state, task);
      expect(Object.isFrozen(next)).toBe(true);
      expect(Object.isFrozen(next.pending)).toBe(true);
    });
  });
});
