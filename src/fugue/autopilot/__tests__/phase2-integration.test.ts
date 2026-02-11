import { describe, expect, it, vi, beforeEach } from 'vitest';

// Phase 1: Runtime core
import {
  createInitialState,
  transitionMode,
  applyTransition,
  isOperational,
} from '../runtime/coordinator';
import { runGuardCheck, evaluateRecovery } from '../runtime/runtime-guard';
import { createHeartbeatState, recordHeartbeat } from '../runtime/heartbeat';
import {
  createCircuitBreakerState,
  recordFailure as cbRecordFailure,
  recordSuccess as cbRecordSuccess,
} from '../runtime/circuit-breaker';

// Phase 2: Queue
import {
  createQueueState,
  createTask,
  enqueue,
  dequeue,
  processTask,
  processBatch,
  canRetry,
  moveToDeadLetter,
} from '../queue/autopilot-queue';

// Phase 2: Audit
import {
  writeAuditEntry,
  writeAuditBatch,
  queryAuditLogs,
  auditModeTransition,
  auditAutoStop,
  auditRecovery,
  auditBudgetUpdate,
  auditTaskDLQ,
} from '../audit/autopilot-audit';

// Phase 2: Cache
import {
  checkAndConsumeNonce,
  checkRateLimit,
  checkWebhookMiddleware,
} from '../cache/nonce-rate-limit';

// Phase 2: Recovery
import {
  evaluateHealthGate,
  DEFAULT_HEALTH_GATE_CONFIG,
} from '../recovery/health-gate';

// Phase 2: Notifications
import {
  createNotification,
  dispatchNotification,
  buildDiscordPayload,
} from '../notify/notification-dispatcher';

import type { Env } from '../../../types';

// =============================================================================
// Mock Helpers
// =============================================================================

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function createMockDB() {
  const runSpy = vi.fn().mockResolvedValue({ meta: { changes: 1 } });
  const allSpy = vi.fn().mockResolvedValue({ results: [] });
  const firstSpy = vi.fn().mockResolvedValue(null);
  const bindSpy = vi.fn().mockReturnValue({ run: runSpy, all: allSpy, first: firstSpy });
  const prepareSpy = vi.fn().mockReturnValue({ bind: bindSpy });
  const batchSpy = vi.fn().mockResolvedValue([]);
  return { prepare: prepareSpy, batch: batchSpy, _spies: { prepareSpy, bindSpy, runSpy, allSpy, firstSpy, batchSpy } };
}

function createMockKV(): KVNamespace & { _store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    _store: store,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => { store.set(key, value); }),
    delete: vi.fn(async () => {}),
    list: vi.fn(async () => ({ keys: [], list_complete: true, cacheStatus: null })),
    getWithMetadata: vi.fn(async () => ({ value: null, metadata: null, cacheStatus: null })),
  } as unknown as KVNamespace & { _store: Map<string, string> };
}

function createMockDO(responseOverride?: (req: Request) => Promise<Response>) {
  const fetchSpy = vi.fn().mockImplementation(async (req: Request) => {
    if (responseOverride) return responseOverride(req);
    return new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  return {
    namespace: {
      idFromName: vi.fn().mockReturnValue('autopilot-id'),
      get: vi.fn().mockReturnValue({ fetch: fetchSpy }),
    } as unknown as DurableObjectNamespace,
    fetchSpy,
  };
}

function createEnv(overrides: Partial<Env> = {}): Env {
  const db = createMockDB();
  const doMock = createMockDO();
  return {
    AI: {} as Ai,
    ENVIRONMENT: 'test',
    DB: db as unknown as D1Database,
    KV: createMockKV() as unknown as KVNamespace,
    AUTOPILOT_COORDINATOR: doMock.namespace,
    AUTOPILOT_API_KEY: 'test-key',
    DISCORD_WEBHOOK_URL: 'https://discord.test/webhook',
    ...overrides,
  };
}

// =============================================================================
// Integration Tests
// =============================================================================

describe('Autopilot Phase 2 Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue(new Response('ok', { status: 200 }));
  });

  // =========================================================================
  // Scenario 1: Normal Operation Lifecycle
  // =========================================================================

  describe('Scenario 1: Normal Operation Lifecycle', () => {
    it('STOPPED -> start -> NORMAL -> guard check -> continue', async () => {
      const env = createEnv();

      // 1. Initial state is STOPPED
      const state0 = createInitialState();
      expect(state0.mode).toBe('STOPPED');
      expect(isOperational(state0)).toBe(false);

      // 2. Manual transition to NORMAL
      const toNormal = transitionMode(state0, 'NORMAL', 'manual start', 1000);
      const state1 = applyTransition(state0, toNormal);
      expect(state1.mode).toBe('NORMAL');
      expect(isOperational(state1)).toBe(true);

      // 3. Audit the transition
      const auditOk = await auditModeTransition(env, 'STOPPED', 'NORMAL', 'manual start', 'admin');
      expect(auditOk).toBe(true);

      // 4. Send notification
      const notification = createNotification('recovery_completed', { approvedBy: 'admin' });
      const notifyResult = await dispatchNotification(env, notification);
      expect(notifyResult.sent).toBe(true);

      // 5. Guard check with healthy state
      const heartbeat = recordHeartbeat(createHeartbeatState(0), 1000);
      const circuit = createCircuitBreakerState();
      const guard = runGuardCheck({
        budget: { spent: 50, limit: 200 },
        circuitBreaker: { state: circuit },
        heartbeat: { state: heartbeat },
      }, 1000);
      expect(guard.verdict).toBe('CONTINUE');
      expect(guard.shouldTransitionToStopped).toBe(false);

      // 6. Queue a guard check task
      let queueState = createQueueState();
      const task = createTask('GUARD_CHECK', { check: true });
      queueState = enqueue(queueState, task);
      expect(queueState.pending).toHaveLength(1);

      // 7. Process the task
      const { result } = await processTask(env, task, queueState);
      expect(result.success).toBe(true);
    });
  });

  // =========================================================================
  // Scenario 2: Budget Critical -> Auto-STOP -> Recovery
  // =========================================================================

  describe('Scenario 2: Budget Critical -> Auto-STOP -> Recovery', () => {
    it('auto-stops on budget critical, then recovers via health gate', async () => {
      const env = createEnv();
      const now = 10_000;

      // 1. System running in NORMAL mode
      const stopped = createInitialState();
      const toNormal = transitionMode(stopped, 'NORMAL', 'test', now);
      const running = applyTransition(stopped, toNormal);

      // 2. Budget hits critical threshold
      const guard = runGuardCheck({
        budget: { spent: 198, limit: 200 },
      }, now);
      expect(guard.verdict).toBe('STOP');
      expect(guard.shouldTransitionToStopped).toBe(true);

      // 3. Auto-stop transition
      const stopResult = transitionMode(running, 'STOPPED', 'auto-stop: budget critical', now);
      const stoppedState = applyTransition(running, stopResult);
      expect(stoppedState.mode).toBe('STOPPED');

      // 4. Audit the auto-stop
      await auditAutoStop(env, 'NORMAL', guard.reasons);

      // 5. Notify
      const notification = createNotification('auto_stop', { reasons: guard.reasons.join('; ') });
      expect(notification.severity).toBe('critical');

      // 6. Recovery: evaluate health gate
      const freshHeartbeat = recordHeartbeat(createHeartbeatState(now - 1000), now);
      const healthGate = evaluateHealthGate({
        runtimeState: stoppedState,
        heartbeatState: freshHeartbeat,
        circuitBreakerState: createCircuitBreakerState(),
        budgetSpent: 100, // budget reduced after investigation
        budgetLimit: 200,
        manualApproval: true,
        approvedBy: 'admin@test.com',
        nowMs: now,
      });
      expect(healthGate.passed).toBe(true);
      expect(healthGate.failedChecks).toHaveLength(0);

      // 7. Recovery approved
      const recovery = evaluateRecovery({
        manualApproval: true,
        approvedBy: 'admin@test.com',
        reason: 'budget adjusted, all health checks pass',
      });
      expect(recovery.allowed).toBe(true);

      // 8. Transition back to NORMAL
      const recoverResult = transitionMode(stoppedState, 'NORMAL', 'recovery', now);
      const recoveredState = applyTransition(stoppedState, recoverResult);
      expect(recoveredState.mode).toBe('NORMAL');

      // 9. Audit recovery
      await auditRecovery(env, true, 'admin@test.com', 'budget adjusted');
    });
  });

  // =========================================================================
  // Scenario 3: Circuit Breaker -> Auto-STOP -> Health Gate Blocks Recovery
  // =========================================================================

  describe('Scenario 3: Circuit breaker blocks recovery', () => {
    it('health gate blocks recovery when circuit is OPEN', async () => {
      const now = 20_000;

      // 1. Circuit breaker trips
      let circuit = createCircuitBreakerState();
      for (let i = 0; i < 5; i++) {
        circuit = cbRecordFailure(circuit, now + i * 100);
      }
      expect(circuit.state).toBe('OPEN');

      // 2. Guard says STOP
      const guard = runGuardCheck({
        circuitBreaker: { state: circuit },
      }, now + 600);
      expect(guard.verdict).toBe('STOP');

      // 3. Auto-stop
      const stopped = createInitialState(); // already STOPPED

      // 4. Health gate should block recovery (circuit still OPEN)
      const freshHeartbeat = recordHeartbeat(createHeartbeatState(now - 1000), now);
      const healthGate = evaluateHealthGate({
        runtimeState: stopped,
        heartbeatState: freshHeartbeat,
        circuitBreakerState: circuit,
        budgetSpent: 100,
        budgetLimit: 200,
        manualApproval: true,
        approvedBy: 'admin@test.com',
        nowMs: now,
      });

      expect(healthGate.passed).toBe(false);
      expect(healthGate.failedChecks).toContain('circuit_breaker');
    });
  });

  // =========================================================================
  // Scenario 4: Webhook Replay Prevention
  // =========================================================================

  describe('Scenario 4: Webhook replay prevention', () => {
    it('blocks replayed webhooks via nonce check', async () => {
      const kv = createMockKV();

      // First request succeeds
      const r1 = await checkWebhookMiddleware(kv, 'nonce-unique-1', '192.168.1.1');
      expect(r1.allowed).toBe(true);

      // Replay with same nonce is blocked
      const r2 = await checkWebhookMiddleware(kv, 'nonce-unique-1', '192.168.1.1');
      expect(r2.allowed).toBe(false);
      expect(r2.reason).toBe('nonce already consumed');
    });

    it('blocks when rate limit exceeded', async () => {
      const kv = createMockKV();
      const config = { windowSeconds: 60, maxRequests: 2, prefix: 'rate:' };

      await checkWebhookMiddleware(kv, 'n1', 'ip-1', undefined, config);
      await checkWebhookMiddleware(kv, 'n2', 'ip-1', undefined, config);
      const r3 = await checkWebhookMiddleware(kv, 'n3', 'ip-1', undefined, config);

      expect(r3.allowed).toBe(false);
      expect(r3.reason).toBe('rate limit exceeded');
    });
  });

  // =========================================================================
  // Scenario 5: Queue with DLQ Flow
  // =========================================================================

  describe('Scenario 5: Queue with DLQ flow', () => {
    it('processes tasks, retries failures, and moves exhausted to DLQ', async () => {
      // Mock: first DO call fails, second succeeds
      const fetchSpy = vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'fail' }), { status: 500 }))
        .mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }));

      const env = createEnv({
        AUTOPILOT_COORDINATOR: {
          idFromName: vi.fn().mockReturnValue('id'),
          get: vi.fn().mockReturnValue({ fetch: fetchSpy }),
        } as unknown as DurableObjectNamespace,
      });

      let state = createQueueState();
      const task = createTask('NOTIFICATION', { msg: 'alert' }, { maxRetries: 1 });
      state = enqueue(state, task);

      // First attempt: fails, gets retried
      const { task: t1, nextState: s1 } = dequeue(state);
      expect(t1).not.toBeNull();
      const { result: r1, nextState: s2 } = await processTask(env, t1!, s1);
      expect(r1.success).toBe(false);
      expect(s2.pending).toHaveLength(1); // retried task re-enqueued

      // Second attempt: succeeds
      const { task: t2, nextState: s3 } = dequeue(s2);
      expect(t2).not.toBeNull();
      expect(t2!.retryCount).toBe(1);
      const { result: r2, nextState: s4 } = await processTask(env, t2!, s3);
      expect(r2.success).toBe(true);
      expect(s4.processedCount).toBe(1);
    });

    it('moves task to DLQ after exhausting retries', async () => {
      const fetchSpy = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'fail' }), { status: 500 }),
      );
      const env = createEnv({
        AUTOPILOT_COORDINATOR: {
          idFromName: vi.fn().mockReturnValue('id'),
          get: vi.fn().mockReturnValue({ fetch: fetchSpy }),
        } as unknown as DurableObjectNamespace,
      });

      let state = createQueueState();
      const task = createTask('AUDIT_LOG', { event: 'test' }, { maxRetries: 0 });
      state = enqueue(state, task);

      const { results, nextState } = await processBatch(env, state, 5);
      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(false);
      expect(nextState.deadLetter).toHaveLength(1);
      expect(nextState.failedCount).toBe(1);

      // Audit the DLQ event
      const auditOk = await auditTaskDLQ(env, task.id, task.type, 'DO returned 500');
      expect(auditOk).toBe(true);
    });
  });

  // =========================================================================
  // Scenario 6: Batch Audit + Notification Pipeline
  // =========================================================================

  describe('Scenario 6: Batch audit + notification pipeline', () => {
    it('records batch audit entries and sends notification', async () => {
      const env = createEnv();

      // Write batch audit entries
      const auditOk = await writeAuditBatch(env, [
        { eventType: 'mode_transition', previousMode: 'STOPPED', newMode: 'NORMAL', reason: 'manual' },
        { eventType: 'guard_check', metadata: { verdict: 'CONTINUE', reasons: [], warnings: [] } },
        { eventType: 'budget_update', metadata: { spent: 150, limit: 200, ratio: 0.75 } },
      ]);
      expect(auditOk).toBe(true);

      // Send notification
      const notification = createNotification('budget_warning', { percentage: '75' });
      const payload = buildDiscordPayload(notification);
      expect(payload.embeds).toHaveLength(1);

      const result = await dispatchNotification(env, notification);
      expect(result.sent).toBe(true);
    });
  });

  // =========================================================================
  // Scenario 7: Full Lifecycle with All Modules
  // =========================================================================

  describe('Scenario 7: Full lifecycle end-to-end', () => {
    it('complete lifecycle: start -> operate -> budget warning -> auto-stop -> recover', async () => {
      const env = createEnv();
      const kv = createMockKV();

      // Phase 1: Start
      let runtime = createInitialState();
      const start = transitionMode(runtime, 'NORMAL', 'initial start', 1000);
      runtime = applyTransition(runtime, start);
      expect(runtime.mode).toBe('NORMAL');
      await auditModeTransition(env, 'STOPPED', 'NORMAL', 'initial start');

      // Phase 2: Normal operation with webhook
      const webhookCheck = await checkWebhookMiddleware(kv, 'nonce-op-1', 'daemon-ip');
      expect(webhookCheck.allowed).toBe(true);

      // Phase 3: Budget approaches warning
      let heartbeat = recordHeartbeat(createHeartbeatState(0), 5000);
      const warningGuard = runGuardCheck({
        budget: { spent: 191, limit: 200 },
        heartbeat: { state: heartbeat },
      }, 5000);
      expect(warningGuard.verdict).toBe('DEGRADE');
      expect(warningGuard.shouldTransitionToDegraded).toBe(true);
      expect(warningGuard.warnings.length).toBeGreaterThan(0);
      await auditBudgetUpdate(env, 191, 200);

      // Phase 4: Budget hits critical -> auto-stop
      const criticalGuard = runGuardCheck({
        budget: { spent: 198, limit: 200 },
      }, 6000);
      expect(criticalGuard.verdict).toBe('STOP');

      const stopTransition = transitionMode(runtime, 'STOPPED', 'auto-stop: budget', 6000);
      runtime = applyTransition(runtime, stopTransition);
      expect(runtime.mode).toBe('STOPPED');
      await auditAutoStop(env, 'NORMAL', criticalGuard.reasons);

      const stopNotify = createNotification('auto_stop', { reasons: criticalGuard.reasons.join('; ') });
      await dispatchNotification(env, stopNotify);

      // Phase 5: Recovery attempt
      heartbeat = recordHeartbeat(createHeartbeatState(5000), 7000);
      const gate = evaluateHealthGate({
        runtimeState: runtime,
        heartbeatState: heartbeat,
        circuitBreakerState: createCircuitBreakerState(),
        budgetSpent: 50, // budget refilled
        budgetLimit: 200,
        manualApproval: true,
        approvedBy: 'admin@test.com',
        nowMs: 7000,
      });
      expect(gate.passed).toBe(true);

      const recoverTransition = transitionMode(runtime, 'NORMAL', 'recovery approved', 7000);
      runtime = applyTransition(runtime, recoverTransition);
      expect(runtime.mode).toBe('NORMAL');
      expect(runtime.transitionCount).toBe(3); // start + stop + recover

      await auditRecovery(env, true, 'admin@test.com', 'budget refilled');
      const recoverNotify = createNotification('recovery_completed', { approvedBy: 'admin@test.com' });
      await dispatchNotification(env, recoverNotify);
    });
  });

  // =========================================================================
  // Cross-Module Immutability
  // =========================================================================

  describe('Cross-module immutability guarantees', () => {
    it('all module outputs are frozen', () => {
      // Runtime
      const state = createInitialState();
      expect(Object.isFrozen(state)).toBe(true);

      // Heartbeat
      const hb = createHeartbeatState(1000);
      expect(Object.isFrozen(hb)).toBe(true);

      // Circuit breaker
      const cb = createCircuitBreakerState();
      expect(Object.isFrozen(cb)).toBe(true);

      // Guard
      const guard = runGuardCheck({ budget: { spent: 50, limit: 200 } }, 1000);
      expect(Object.isFrozen(guard)).toBe(true);

      // Queue
      const qs = createQueueState();
      expect(Object.isFrozen(qs)).toBe(true);

      // Health gate
      const gate = evaluateHealthGate({
        runtimeState: state,
        heartbeatState: recordHeartbeat(hb, 1000),
        circuitBreakerState: cb,
        budgetSpent: 50,
        budgetLimit: 200,
        manualApproval: true,
        approvedBy: 'admin',
        nowMs: 1000,
      });
      expect(Object.isFrozen(gate)).toBe(true);

      // Notification
      const notif = createNotification('auto_stop');
      expect(Object.isFrozen(notif)).toBe(true);
    });
  });
});
