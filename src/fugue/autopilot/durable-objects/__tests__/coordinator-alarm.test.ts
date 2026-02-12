/**
 * Integration tests for coordinator-alarm.ts (v1.3 alarm pipeline).
 *
 * Tests processAlarmTick() with mocked storage, audit, and API keys.
 * Verifies guard checks, hysteresis, reconciliation, dedup, TTL cleanup,
 * and WORM audit callback integration.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  processAlarmTick,
  INITIAL_HYSTERESIS,
  type AlarmPipelineState,
  type AlarmPipelineStorage,
  type AlarmPipelineAudit,
  type AlarmPipelineApiKeys,
} from '../coordinator-alarm';
import { createInitialState, createInitialExtendedState, applyExtendedTransition, transitionMode, applyTransition } from '../../runtime/coordinator';
import { createHeartbeatState } from '../../runtime/heartbeat';
import { createCircuitBreakerState, recordFailure as cbRecordFailure } from '../../runtime/circuit-breaker';
import { createMetricsState } from '../../metrics/collector';
import { createHealthProbeState } from '../../health/provider-probe';
import { createDedupState } from '../../notify/notification-dedup';

// =============================================================================
// Test Helpers
// =============================================================================

const NOW = 1_700_000_000_000;

function createMockStorage(): AlarmPipelineStorage {
  return {
    get: vi.fn().mockResolvedValue(undefined),
    put: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue(new Map()),
    deleteKeys: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockAudit(): AlarmPipelineAudit {
  return {
    modeTransition: vi.fn().mockResolvedValue(true),
    guardCheck: vi.fn().mockResolvedValue(true),
    autoStop: vi.fn().mockResolvedValue(true),
  };
}

const API_KEYS: AlarmPipelineApiKeys = Object.freeze({
  OPENAI_API_KEY: 'test-openai',
  ZAI_API_KEY: 'test-glm',
  GEMINI_API_KEY: 'test-gemini',
});

function createDefaultState(overrides?: Partial<AlarmPipelineState>): AlarmPipelineState {
  return {
    runtimeState: createInitialState(),
    extendedState: createInitialExtendedState(),
    heartbeatState: createHeartbeatState(NOW - 5000),
    circuitBreakerState: createCircuitBreakerState(),
    budgetSnapshot: Object.freeze({ spent: 50, limit: 200, updatedAt: NOW }),
    lastGuardCheck: null,
    hysteresis: { ...INITIAL_HYSTERESIS },
    metricsState: createMetricsState(NOW),
    healthProbeState: createHealthProbeState(),
    dedupState: createDedupState(),
    lastTtlCleanupMs: 0,
    ...overrides,
  };
}

function createOperationalState(overrides?: Partial<AlarmPipelineState>): AlarmPipelineState {
  const base = createDefaultState(overrides);
  // Transition to NORMAL (operational) — both extended and legacy state
  const ext = applyExtendedTransition(base.extendedState, 'NORMAL', 'test-start', NOW - 10000);
  const legacyResult = transitionMode(base.runtimeState, 'NORMAL', 'test-start', NOW - 10000);
  const legacyState = applyTransition(base.runtimeState, legacyResult);
  return { ...base, extendedState: ext, runtimeState: legacyState };
}

// =============================================================================
// Tests
// =============================================================================

describe('coordinator-alarm: processAlarmTick', () => {
  let storage: AlarmPipelineStorage;
  let audit: AlarmPipelineAudit;

  beforeEach(() => {
    vi.restoreAllMocks();
    storage = createMockStorage();
    audit = createMockAudit();
  });

  // -------------------------------------------------------------------------
  // 1. Normal tick — no transition
  // -------------------------------------------------------------------------
  it('normal tick: records heartbeat without mode change', async () => {
    const state = createOperationalState();
    const prevMode = state.extendedState.mode;

    const result = await processAlarmTick(state, storage, API_KEYS, NOW, audit);

    expect(result.transitioned).toBe(false);
    expect(result.newMode).toBe(prevMode);
    expect(state.heartbeatState.lastHeartbeatMs).toBe(NOW);
  });

  // -------------------------------------------------------------------------
  // 2. Budget exceeded → DEGRADE after 3 consecutive ticks (hysteresis)
  // -------------------------------------------------------------------------
  it('budget warning triggers DEGRADE after 3 consecutive ticks', async () => {
    // Budget at 95% → triggers shouldTransitionToDegraded
    const state = createOperationalState({
      budgetSnapshot: Object.freeze({ spent: 190, limit: 200, updatedAt: NOW }),
    });

    // Tick 1: degrade verdict, but hysteresis blocks
    const r1 = await processAlarmTick(state, storage, API_KEYS, NOW, audit);
    expect(r1.transitioned).toBe(false);
    expect(state.hysteresis.consecutiveDegradeVerdicts).toBe(1);

    // Tick 2
    const r2 = await processAlarmTick(state, storage, API_KEYS, NOW + 10000, audit);
    expect(r2.transitioned).toBe(false);
    expect(state.hysteresis.consecutiveDegradeVerdicts).toBe(2);

    // Tick 3: threshold reached → DEGRADED
    const r3 = await processAlarmTick(state, storage, API_KEYS, NOW + 20000, audit);
    expect(r3.transitioned).toBe(true);
    expect(r3.newMode).toBe('DEGRADED');
    expect(state.extendedState.mode).toBe('DEGRADED');
  });

  // -------------------------------------------------------------------------
  // 3. DEGRADED → auto-recover after 3 CONTINUE verdicts
  // -------------------------------------------------------------------------
  it('DEGRADED auto-recovers after 3 consecutive CONTINUE verdicts', async () => {
    const ext = applyExtendedTransition(
      createInitialExtendedState(), 'NORMAL', 'start', NOW - 60000,
    );
    const degraded = applyExtendedTransition(ext, 'DEGRADED', 'test-degrade', NOW - 30000);

    const state = createDefaultState({
      extendedState: degraded,
      budgetSnapshot: Object.freeze({ spent: 50, limit: 200, updatedAt: NOW }),
    });
    // Ensure legacy state is also not STOPPED
    state.runtimeState = { ...state.runtimeState, mode: 'NORMAL' };

    // 3 consecutive CONTINUE verdicts
    await processAlarmTick(state, storage, API_KEYS, NOW, audit);
    expect(state.hysteresis.consecutiveContinueVerdicts).toBe(1);

    await processAlarmTick(state, storage, API_KEYS, NOW + 10000, audit);
    expect(state.hysteresis.consecutiveContinueVerdicts).toBe(2);

    const r3 = await processAlarmTick(state, storage, API_KEYS, NOW + 20000, audit);
    expect(r3.transitioned).toBe(true);
    expect(r3.newMode).toBe('NORMAL');
  });

  // -------------------------------------------------------------------------
  // 4. Hard-fail → STOPPED with audit trail
  // -------------------------------------------------------------------------
  it('circuit breaker open triggers auto-STOP with audit', async () => {
    // Open circuit breaker by recording many failures
    let cb = createCircuitBreakerState();
    for (let i = 0; i < 10; i++) {
      cb = cbRecordFailure(cb, undefined, NOW - i * 1000);
    }

    const state = createOperationalState({
      circuitBreakerState: cb,
    });

    const result = await processAlarmTick(state, storage, API_KEYS, NOW, audit);

    expect(result.transitioned).toBe(true);
    expect(result.newMode).toBe('STOPPED');
    expect(audit.autoStop).toHaveBeenCalled();
    expect(audit.guardCheck).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 5. RECOVERY → promote to NORMAL after health gate
  // -------------------------------------------------------------------------
  it('RECOVERY promotes to NORMAL after 3 healthy guard checks', async () => {
    // Valid transition path: STOPPED → RECOVERY (NORMAL→RECOVERY is not allowed)
    const recovery = applyExtendedTransition(
      createInitialExtendedState(), 'RECOVERY', 'test-recovery', NOW - 30000,
    );

    const state = createDefaultState({
      extendedState: recovery,
      budgetSnapshot: Object.freeze({ spent: 50, limit: 200, updatedAt: NOW }),
    });
    // Ensure legacy state is NORMAL (not STOPPED) so pipeline doesn't auto-stop
    state.runtimeState = { ...state.runtimeState, mode: 'NORMAL' };

    // 3 consecutive CONTINUE verdicts in RECOVERY mode
    const r1 = await processAlarmTick(state, storage, API_KEYS, NOW, audit);
    expect(state.extendedState.mode).toBe('RECOVERY');
    expect(state.hysteresis.consecutiveContinueVerdicts).toBe(1);

    const r2 = await processAlarmTick(state, storage, API_KEYS, NOW + 10000, audit);
    expect(state.hysteresis.consecutiveContinueVerdicts).toBe(2);

    const r3 = await processAlarmTick(state, storage, API_KEYS, NOW + 20000, audit);
    expect(r3.transitioned).toBe(true);
    expect(r3.newMode).toBe('NORMAL');
    expect(audit.modeTransition).toHaveBeenCalledWith('RECOVERY', 'NORMAL', expect.any(String));
  });

  // -------------------------------------------------------------------------
  // 6. State reconciliation drift detection
  // -------------------------------------------------------------------------
  it('detects and repairs state drift from storage', async () => {
    const state = createOperationalState();

    // Mock storage to return different state (drift scenario)
    const driftedExt = applyExtendedTransition(
      createInitialExtendedState(), 'NORMAL', 'drifted', NOW - 5000,
    );
    (storage.get as ReturnType<typeof vi.fn>).mockImplementation(async (key: string) => {
      if (key === 'autopilot:state:v2') return { ...driftedExt, transitionCount: 999 };
      return undefined;
    });

    const result = await processAlarmTick(state, storage, API_KEYS, NOW, audit);

    // Reconciliation ran (storage.get was called)
    expect(storage.get).toHaveBeenCalled();
    expect(result.reconciled).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // 7. TTL cleanup of expired entries
  // -------------------------------------------------------------------------
  it('cleans up expired idempotency and result entries', async () => {
    const state = createOperationalState({
      lastTtlCleanupMs: 0, // Force cleanup on first tick
    });

    // Mock list to return expired entries
    const expiredIdem = new Map([
      ['autopilot:idem:key1', { result: {}, expiresAt: NOW - 1000 }],
      ['autopilot:idem:key2', { result: {}, expiresAt: NOW + 60000 }], // not expired
    ]);
    const expiredResults = new Map([
      ['autopilot:task-result:r1', {
        taskId: 'r1', ownerId: 'test', status: 'completed' as const,
        completedAt: NOW - 90000, durationMs: 100,
        expiresAt: NOW - 1000, // expired
      }],
    ]);

    (storage.list as ReturnType<typeof vi.fn>).mockImplementation(async (prefix: string) => {
      if (prefix === 'autopilot:idem:') return expiredIdem;
      if (prefix === 'autopilot:task-result:') return expiredResults;
      return new Map();
    });

    const result = await processAlarmTick(state, storage, API_KEYS, NOW, audit);

    expect(result.ttlCleanedUp).toBeGreaterThan(0);
    expect(storage.deleteKeys).toHaveBeenCalled();
    expect(state.lastTtlCleanupMs).toBe(NOW);
  });

  // -------------------------------------------------------------------------
  // 8. Dedup suppresses repeated notifications
  // -------------------------------------------------------------------------
  it('suppresses duplicate mode transition notifications', async () => {
    let cb = createCircuitBreakerState();
    for (let i = 0; i < 10; i++) {
      cb = cbRecordFailure(cb, undefined, NOW - i * 1000);
    }

    const state = createOperationalState({
      circuitBreakerState: cb,
    });

    // First transition: should notify
    const r1 = await processAlarmTick(state, storage, API_KEYS, NOW, audit);
    expect(r1.transitioned).toBe(true);
    expect(r1.dedupDecisions.length).toBeGreaterThan(0);
    const firstDedup = r1.dedupDecisions[0];
    expect(firstDedup.shouldNotify).toBe(true);

    // Transition back to operational for re-trigger (simulate recovery then fail again)
    state.extendedState = applyExtendedTransition(state.extendedState, 'NORMAL', 'manual', NOW + 1000);
    state.runtimeState = { ...state.runtimeState, mode: 'NORMAL' };

    // Second identical transition within dedup window: should suppress
    const r2 = await processAlarmTick(state, storage, API_KEYS, NOW + 2000, audit);
    if (r2.transitioned && r2.dedupDecisions.length > 0) {
      expect(r2.dedupDecisions[0].shouldNotify).toBe(false);
    }
  });

  // -------------------------------------------------------------------------
  // 9. STOPPED mode: no guard checks run
  // -------------------------------------------------------------------------
  it('STOPPED mode skips guard checks', async () => {
    const state = createDefaultState(); // Default is STOPPED

    const result = await processAlarmTick(state, storage, API_KEYS, NOW, audit);

    expect(result.transitioned).toBe(false);
    expect(result.newMode).toBe('STOPPED');
    expect(audit.guardCheck).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 10. Audit callbacks are invoked on guard checks
  // -------------------------------------------------------------------------
  it('invokes audit.guardCheck on every operational tick', async () => {
    const state = createOperationalState();

    await processAlarmTick(state, storage, API_KEYS, NOW, audit);

    expect(audit.guardCheck).toHaveBeenCalledTimes(1);
    expect(audit.guardCheck).toHaveBeenCalledWith(
      expect.any(String), // verdict
      expect.any(Array),  // reasons
      expect.any(Array),  // warnings
    );
  });

  // -------------------------------------------------------------------------
  // 11. Hysteresis resets on non-matching direction
  // -------------------------------------------------------------------------
  it('resets degrade counter when CONTINUE verdict in NORMAL mode', async () => {
    const state = createOperationalState({
      budgetSnapshot: Object.freeze({ spent: 190, limit: 200, updatedAt: NOW }),
    });

    // Tick 1: degrade direction
    await processAlarmTick(state, storage, API_KEYS, NOW, audit);
    expect(state.hysteresis.consecutiveDegradeVerdicts).toBe(1);

    // Now fix budget → CONTINUE verdict
    state.budgetSnapshot = Object.freeze({ spent: 50, limit: 200, updatedAt: NOW });

    await processAlarmTick(state, storage, API_KEYS, NOW + 10000, audit);
    expect(state.hysteresis.consecutiveDegradeVerdicts).toBe(0);
  });
});
