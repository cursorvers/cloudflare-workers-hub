/**
 * AutopilotCoordinator Durable Object
 *
 * Management Plane for 24h autonomous runtime safety.
 * Wraps Phase 1 pure functions (coordinator, runtime-guard, heartbeat, etc.)
 * into an alarm-driven Durable Object with HTTP API.
 *
 * Execution logic extracted to coordinator-execute.ts (Phase 5a refactor).
 * Separated from RunCoordinator (Data Plane: orchestration runs/steps).
 * Fail-closed: any unhandled alarm error transitions to STOPPED.
 */

import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../../../types';
import {
  createInitialState,
  transitionMode,
  applyTransition,
  createInitialExtendedState,
  applyExtendedTransition,
  type RuntimeState,
  type RuntimeMode,
  type ModeTransitionResult,
  type ExtendedRuntimeState,
} from '../runtime/coordinator';
import type { ExtendedMode } from '../runtime/mode-machine';
import { isModeOperational } from '../runtime/mode-machine';
import {
  evaluateRecovery,
  type GuardCheckResult,
  type RecoveryRequest,
  type RecoveryResult,
} from '../runtime/runtime-guard';
import {
  createHeartbeatState,
  recordHeartbeat,
  type HeartbeatState,
} from '../runtime/heartbeat';
import {
  createCircuitBreakerState,
  recordSuccess as cbRecordSuccess,
  recordFailure as cbRecordFailure,
  type CircuitBreakerState,
} from '../runtime/circuit-breaker';
import { type ExecutionQueueState, createExecutionQueueState } from '../queue/execution-queue';
import { processExecutionBatch } from '../queue/execution-consumer';
import { handleExecuteRequest, handleTaskPollRequest } from './coordinator-execute';
import {
  type MetricsState,
  createMetricsState,
  createSnapshot,
  exportPrometheus,
  createOpsSummary,
} from '../metrics/collector';
import {
  type HealthProbeState,
  createHealthProbeState,
  getHealthSnapshot,
} from '../health/provider-probe';
import {
  processAlarmTick,
  INITIAL_HYSTERESIS,
  type HysteresisState,
  type AlarmPipelineState,
} from './coordinator-alarm';
import { createDedupState, type DedupState } from '../notify/notification-dedup';
import {
  auditModeTransition,
  auditGuardCheck,
  auditAutoStop,
} from '../audit/autopilot-audit';
import { safeLog } from '../../../utils/log-sanitizer';

// =============================================================================
// Constants
// =============================================================================

const ALARM_INTERVAL_MS = 10_000; // 10s heartbeat alarm
const STORAGE_KEY_STATE = 'autopilot:state';
const STORAGE_KEY_STATE_V2 = 'autopilot:state:v2';
const STORAGE_KEY_HEARTBEAT = 'autopilot:heartbeat';
const STORAGE_KEY_CIRCUIT = 'autopilot:circuit';
const STORAGE_KEY_BUDGET = 'autopilot:budget';

/** Execution consumer alarm interval (5s, separate from 10s health alarm) */
const EXEC_CONSUMER_INTERVAL_MS = 5_000;

// =============================================================================
// Types
// =============================================================================

export interface AutopilotStatus {
  readonly mode: RuntimeMode;
  readonly extendedMode: ExtendedMode;
  readonly isOperational: boolean;
  readonly transitionCount: number;
  readonly lastTransition: ModeTransitionResult | null;
  readonly lastGuardCheck: GuardCheckResult | null;
  readonly heartbeatState: HeartbeatState;
  readonly circuitBreakerState: CircuitBreakerState;
  readonly budgetSnapshot: BudgetSnapshot;
  readonly timestamp: number;
}

export interface BudgetSnapshot {
  readonly spent: number;
  readonly limit: number;
  readonly updatedAt: number;
}

export interface TransitionRequest {
  readonly targetMode: RuntimeMode;
  readonly reason: string;
}

// HysteresisState imported from coordinator-alarm.ts

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
  return jsonResponse(
    { success: false, error: { code: code ?? 'ERROR', message } },
    status,
  );
}

function freezeStatus(status: AutopilotStatus): AutopilotStatus {
  return Object.freeze({ ...status });
}

const DEFAULT_BUDGET_SNAPSHOT: BudgetSnapshot = Object.freeze({
  spent: 0,
  limit: 200,
  updatedAt: 0,
});

// =============================================================================
// Durable Object
// =============================================================================

export class AutopilotCoordinator extends DurableObject<Env> {
  private runtimeState: RuntimeState;
  private extendedState: ExtendedRuntimeState;
  private heartbeatState: HeartbeatState;
  private circuitBreakerState: CircuitBreakerState;
  private budgetSnapshot: BudgetSnapshot;
  private lastGuardCheck: GuardCheckResult | null;
  private hysteresis: HysteresisState;
  private executionQueue: ExecutionQueueState;
  private lastExecConsumerRunMs: number;
  private metricsState: MetricsState;
  private healthProbeState: HealthProbeState;
  private dedupState: DedupState;
  private lastTtlCleanupMs: number;
  private initialized: boolean;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.runtimeState = createInitialState();
    this.extendedState = createInitialExtendedState();
    this.heartbeatState = createHeartbeatState(Date.now());
    this.circuitBreakerState = createCircuitBreakerState();
    this.budgetSnapshot = DEFAULT_BUDGET_SNAPSHOT;
    this.lastGuardCheck = null;
    this.hysteresis = { ...INITIAL_HYSTERESIS };
    this.executionQueue = createExecutionQueueState();
    this.lastExecConsumerRunMs = 0;
    this.metricsState = createMetricsState(Date.now());
    this.healthProbeState = createHealthProbeState();
    this.dedupState = createDedupState();
    this.lastTtlCleanupMs = 0;
    this.initialized = false;
  }

  /**
   * Lazy initialization: restore persisted state from SQLite storage.
   */
  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;

    try {
      const [state, stateV2, heartbeat, circuit, budget] = await Promise.all([
        this.ctx.storage.get<RuntimeState>(STORAGE_KEY_STATE),
        this.ctx.storage.get<ExtendedRuntimeState>(STORAGE_KEY_STATE_V2),
        this.ctx.storage.get<HeartbeatState>(STORAGE_KEY_HEARTBEAT),
        this.ctx.storage.get<CircuitBreakerState>(STORAGE_KEY_CIRCUIT),
        this.ctx.storage.get<BudgetSnapshot>(STORAGE_KEY_BUDGET),
      ]);

      if (state) this.runtimeState = Object.freeze({ ...state });
      // v2 takes priority; fall back to legacy state conversion
      if (stateV2) {
        this.extendedState = Object.freeze({ ...stateV2 });
      } else if (state) {
        // Convert legacy state to extended state
        const legacyMode: ExtendedMode = state.mode === 'NORMAL' ? 'NORMAL' : 'STOPPED';
        this.extendedState = Object.freeze({
          mode: legacyMode,
          previousMode: null,
          lastTransition: state.lastTransition,
          transitionCount: state.transitionCount,
          enteredCurrentModeAt: Date.now(),
        });
      }
      if (heartbeat) this.heartbeatState = Object.freeze({ ...heartbeat });
      if (circuit) this.circuitBreakerState = Object.freeze({ ...circuit });
      if (budget) this.budgetSnapshot = Object.freeze({ ...budget });
    } catch (err) {
      safeLog.error('[AutopilotCoordinator] Storage restore failed (fail-closed)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    this.initialized = true;
    await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
  }

  /**
   * Persist all state to SQLite storage atomically.
   */
  private async persistState(): Promise<void> {
    // Mirror write: always persist both v1 (legacy) and v2 (extended)
    await this.ctx.storage.put({
      [STORAGE_KEY_STATE]: this.runtimeState,
      [STORAGE_KEY_STATE_V2]: this.extendedState,
      [STORAGE_KEY_HEARTBEAT]: this.heartbeatState,
      [STORAGE_KEY_CIRCUIT]: this.circuitBreakerState,
      [STORAGE_KEY_BUDGET]: this.budgetSnapshot,
    });
  }

  /** Check if system is operational using extended mode */
  private isSystemOperational(): boolean {
    return isModeOperational(this.extendedState.mode);
  }

  /**
   * HTTP API router.
   */
  async fetch(request: Request): Promise<Response> {
    const expectedKey =
      this.env.AUTOPILOT_API_KEY ??
      this.env.WORKERS_API_KEY ??
      this.env.ASSISTANT_API_KEY;

    if (expectedKey) {
      const authHeader = request.headers.get('Authorization');
      const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
      if (token !== expectedKey) {
        return errorResponse('Unauthorized', 401, 'UNAUTHORIZED');
      }
    }

    await this.ensureInitialized();

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === '/status' && request.method === 'GET') {
        return this.handleStatus();
      }

      if (path === '/transition' && request.method === 'POST') {
        return this.handleTransition(request);
      }

      if (path === '/recovery' && request.method === 'POST') {
        return this.handleRecovery(request);
      }

      if (path === '/heartbeat' && request.method === 'POST') {
        return this.handleHeartbeat();
      }

      if (path === '/budget' && request.method === 'POST') {
        return this.handleBudgetUpdate(request);
      }

      if (path === '/circuit/success' && request.method === 'POST') {
        return this.handleCircuitSuccess();
      }

      if (path === '/circuit/failure' && request.method === 'POST') {
        return this.handleCircuitFailure();
      }

      if (path === '/execute' && request.method === 'POST') {
        return handleExecuteRequest(request, this.buildExecuteContext());
      }

      // GET /task/:id — poll for async execution result
      if (path.startsWith('/task/') && request.method === 'GET') {
        const taskId = path.slice(6); // strip '/task/'
        return handleTaskPollRequest(taskId, this.buildExecuteContext());
      }

      // Phase 6: Observability endpoints
      if (path === '/metrics' && request.method === 'GET') {
        return this.handleMetrics();
      }

      if (path === '/metrics/prometheus' && request.method === 'GET') {
        return this.handleMetricsPrometheus();
      }

      if (path === '/ops/summary' && request.method === 'GET') {
        return this.handleOpsSummary();
      }

      return errorResponse('Not found', 404, 'NOT_FOUND');
    } catch (err) {
      safeLog.error('[AutopilotCoordinator] Request error', {
        error: err instanceof Error ? err.message : String(err),
        path,
      });
      return errorResponse('Internal error', 500, 'INTERNAL_ERROR');
    }
  }

  /** GET /status */
  private handleStatus(): Response {
    const status = freezeStatus({
      mode: this.runtimeState.mode,
      extendedMode: this.extendedState.mode,
      isOperational: this.isSystemOperational(),
      transitionCount: this.extendedState.transitionCount,
      lastTransition: this.extendedState.lastTransition,
      lastGuardCheck: this.lastGuardCheck,
      heartbeatState: this.heartbeatState,
      circuitBreakerState: this.circuitBreakerState,
      budgetSnapshot: this.budgetSnapshot,
      timestamp: Date.now(),
    });
    return jsonResponse({ success: true, data: status });
  }

  /** POST /transition */
  private async handleTransition(request: Request): Promise<Response> {
    const body = await request.json().catch(() => null);
    if (!body) return errorResponse('Request body must be valid JSON', 400, 'INVALID_BODY');

    const { targetMode, reason } = body as TransitionRequest;
    if (!targetMode || !reason) {
      return errorResponse('targetMode and reason are required', 400, 'VALIDATION_ERROR');
    }
    if (targetMode !== 'NORMAL' && targetMode !== 'STOPPED') {
      return errorResponse('targetMode must be NORMAL or STOPPED', 400, 'VALIDATION_ERROR');
    }

    const now = Date.now();

    // Legacy path
    const result = transitionMode(this.runtimeState, targetMode, reason, now);
    this.runtimeState = applyTransition(this.runtimeState, result);

    // Sync extended state: map legacy NORMAL/STOPPED to extended mode
    const extTarget: ExtendedMode = targetMode;
    this.extendedState = applyExtendedTransition(this.extendedState, extTarget, reason, now);
    // Reset hysteresis on manual transition
    this.hysteresis = { ...INITIAL_HYSTERESIS };

    await this.persistState();

    safeLog.info('[AutopilotCoordinator] Mode transition', {
      from: result.previousMode,
      to: result.currentMode,
      extendedMode: this.extendedState.mode,
      success: result.success,
      reason: result.reason,
    });

    return jsonResponse({ success: true, data: result });
  }

  /** POST /recovery — Initiates STOPPED→RECOVERY (Phase 3) or STOPPED→NORMAL (legacy) */
  private async handleRecovery(request: Request): Promise<Response> {
    const body = await request.json().catch(() => null);
    if (!body) return errorResponse('Request body must be valid JSON', 400, 'INVALID_BODY');

    const recoveryRequest = body as RecoveryRequest;
    const recoveryResult: RecoveryResult = evaluateRecovery(recoveryRequest);

    if (!recoveryResult.allowed) {
      return jsonResponse({ success: false, data: recoveryResult }, 403);
    }

    const now = Date.now();
    const reason = `recovery: ${recoveryResult.reason}`;

    // Phase 3: STOPPED → RECOVERY (alarm will promote to NORMAL after health gate)
    // Extended state goes through RECOVERY intermediate
    this.extendedState = applyExtendedTransition(this.extendedState, 'RECOVERY', reason, now);

    // Legacy path: still STOPPED→NORMAL for backward compatibility
    const result = transitionMode(this.runtimeState, 'NORMAL', reason, now);
    this.runtimeState = applyTransition(this.runtimeState, result);

    this.circuitBreakerState = createCircuitBreakerState();
    // Reset hysteresis for recovery
    this.hysteresis = { ...INITIAL_HYSTERESIS };
    await this.persistState();

    safeLog.info('[AutopilotCoordinator] Recovery initiated', {
      approvedBy: recoveryRequest.approvedBy,
      reason: recoveryRequest.reason,
      extendedMode: this.extendedState.mode,
      legacyMode: this.runtimeState.mode,
    });

    return jsonResponse({
      success: true,
      data: { recovery: recoveryResult, transition: result, extendedMode: this.extendedState.mode },
    });
  }

  /** POST /heartbeat */
  private async handleHeartbeat(): Promise<Response> {
    const now = Date.now();
    this.heartbeatState = recordHeartbeat(this.heartbeatState, now);
    await this.persistState();
    return jsonResponse({
      success: true,
      data: { heartbeatState: this.heartbeatState, timestamp: now },
    });
  }

  /** POST /budget */
  private async handleBudgetUpdate(request: Request): Promise<Response> {
    const body = await request.json().catch(() => null);
    if (!body) return errorResponse('Request body must be valid JSON', 400, 'INVALID_BODY');

    const { spent, limit } = body as { spent: number; limit: number };
    if (typeof spent !== 'number' || typeof limit !== 'number') {
      return errorResponse('spent and limit must be numbers', 400, 'VALIDATION_ERROR');
    }

    this.budgetSnapshot = Object.freeze({ spent, limit, updatedAt: Date.now() });
    await this.persistState();
    return jsonResponse({ success: true, data: this.budgetSnapshot });
  }

  /** POST /circuit/success */
  private async handleCircuitSuccess(): Promise<Response> {
    this.circuitBreakerState = cbRecordSuccess(this.circuitBreakerState);
    await this.persistState();
    return jsonResponse({ success: true, data: { circuitBreakerState: this.circuitBreakerState } });
  }

  /** POST /circuit/failure */
  private async handleCircuitFailure(): Promise<Response> {
    const now = Date.now();
    this.circuitBreakerState = cbRecordFailure(this.circuitBreakerState, undefined, now);
    await this.persistState();
    return jsonResponse({ success: true, data: { circuitBreakerState: this.circuitBreakerState } });
  }

  /** GET /metrics — JSON metrics snapshot (auth required) */
  private handleMetrics(): Response {
    const snapshot = createSnapshot(this.metricsState);
    return jsonResponse({ success: true, data: snapshot });
  }

  /** GET /metrics/prometheus — Prometheus text format */
  private handleMetricsPrometheus(): Response {
    const snapshot = createSnapshot(this.metricsState);
    const text = exportPrometheus(snapshot);
    return new Response(text, {
      status: 200,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  /** GET /ops/summary — Compact operational summary for dashboards */
  private handleOpsSummary(): Response {
    const snapshot = createSnapshot(this.metricsState);
    const providers = getHealthSnapshot(this.healthProbeState);
    const summary = createOpsSummary(snapshot, providers);
    return jsonResponse({ success: true, data: summary });
  }

  /** Build execution context for coordinator-execute module (DI) */
  private buildExecuteContext() {
    return {
      extendedMode: this.extendedState.mode,
      budgetSpent: this.budgetSnapshot.spent,
      budgetLimit: this.budgetSnapshot.limit,
      apiKeys: {
        OPENAI_API_KEY: this.env.OPENAI_API_KEY,
        ZAI_API_KEY: this.env.ZAI_API_KEY,
        GEMINI_API_KEY: this.env.GEMINI_API_KEY,
      },
      strictEffects: this.env.AUTOPILOT_STRICT_EFFECTS === 'true',
      asyncEnabled: this.env.AUTOPILOT_ASYNC_EXECUTION === 'true',
      storage: {
        get: async <T>(key: string) => this.ctx.storage.get<T>(key),
        put: async (entries: Record<string, unknown>) => this.ctx.storage.put(entries),
        delete: async (key: string) => this.ctx.storage.delete(key),
      },
      isOperational: () => this.isSystemOperational(),
      getExecutionQueue: () => this.executionQueue,
      setExecutionQueue: (state: ExecutionQueueState) => { this.executionQueue = state; },
    };
  }

  /**
   * Alarm handler: delegates to coordinator-alarm pipeline.
   * Fail-closed: any error -> STOPPED.
   */
  async alarm(): Promise<void> {
    try {
      await this.ensureInitialized();

      const now = Date.now();

      // Build mutable state container for the alarm pipeline
      const pipelineState: AlarmPipelineState = {
        runtimeState: this.runtimeState,
        extendedState: this.extendedState,
        heartbeatState: this.heartbeatState,
        circuitBreakerState: this.circuitBreakerState,
        budgetSnapshot: this.budgetSnapshot,
        lastGuardCheck: this.lastGuardCheck,
        hysteresis: this.hysteresis,
        metricsState: this.metricsState,
        healthProbeState: this.healthProbeState,
        dedupState: this.dedupState,
        lastTtlCleanupMs: this.lastTtlCleanupMs,
      };

      // Delegate all guard/mode/reconciliation/probe logic to pipeline
      await processAlarmTick(
        pipelineState,
        {
          get: async <T>(key: string) => this.ctx.storage.get<T>(key),
          put: async (entries: Record<string, unknown>) => this.ctx.storage.put(entries),
          list: async <T>(prefix: string) => this.ctx.storage.list<T>({ prefix }),
          deleteKeys: async (keys: string[]) => { for (const k of keys) await this.ctx.storage.delete(k); },
        },
        {
          OPENAI_API_KEY: this.env.OPENAI_API_KEY,
          ZAI_API_KEY: this.env.ZAI_API_KEY,
          GEMINI_API_KEY: this.env.GEMINI_API_KEY,
        },
        now,
        {
          modeTransition: (prev, next, reason) => auditModeTransition(this.env, prev, next, reason, 'alarm-pipeline'),
          guardCheck: (verdict, reasons, warnings) => auditGuardCheck(this.env, verdict, reasons, warnings),
          autoStop: (prev, reasons) => auditAutoStop(this.env, prev, reasons),
        },
      );

      // Write back mutated state from pipeline
      this.runtimeState = pipelineState.runtimeState;
      this.extendedState = pipelineState.extendedState;
      this.heartbeatState = pipelineState.heartbeatState;
      this.circuitBreakerState = pipelineState.circuitBreakerState;
      this.budgetSnapshot = pipelineState.budgetSnapshot;
      this.lastGuardCheck = pipelineState.lastGuardCheck;
      this.hysteresis = pipelineState.hysteresis;
      this.metricsState = pipelineState.metricsState;
      this.healthProbeState = pipelineState.healthProbeState;
      this.dedupState = pipelineState.dedupState;
      this.lastTtlCleanupMs = pipelineState.lastTtlCleanupMs;

      // Execution consumer: process async TOOL_EXECUTION tasks (5s interval)
      if (now - this.lastExecConsumerRunMs >= EXEC_CONSUMER_INTERVAL_MS) {
        this.lastExecConsumerRunMs = now;
        await this.processExecutionQueue();
      }

      await this.persistState();
    } catch (err) {
      safeLog.error('[AutopilotCoordinator] Alarm error (fail-closed)', {
        error: err instanceof Error ? err.message : String(err),
      });

      try {
        const reason = `fail-closed: alarm error (${err instanceof Error ? err.message : 'unknown'})`;
        this.extendedState = applyExtendedTransition(this.extendedState, 'STOPPED', reason);
        const failResult = transitionMode(this.runtimeState, 'STOPPED', reason);
        this.runtimeState = applyTransition(this.runtimeState, failResult);
        this.hysteresis = { ...INITIAL_HYSTERESIS };
        await this.persistState();
      } catch (persistErr) {
        safeLog.error('[AutopilotCoordinator] Failed to persist fail-closed state', {
          error: persistErr instanceof Error ? persistErr.message : String(persistErr),
        });
      }
    } finally {
      try {
        await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
      } catch (alarmErr) {
        safeLog.error('[AutopilotCoordinator] Failed to schedule alarm', {
          error: alarmErr instanceof Error ? alarmErr.message : String(alarmErr),
        });
      }
    }
  }

  /**
   * Process pending execution tasks via the extracted consumer module.
   */
  private async processExecutionQueue(): Promise<void> {
    this.executionQueue = await processExecutionBatch(this.executionQueue, {
      extendedMode: this.extendedState.mode,
      budgetSpent: this.budgetSnapshot.spent,
      budgetLimit: this.budgetSnapshot.limit,
      apiKeys: {
        OPENAI_API_KEY: this.env.OPENAI_API_KEY,
        ZAI_API_KEY: this.env.ZAI_API_KEY,
        GEMINI_API_KEY: this.env.GEMINI_API_KEY,
      },
      storage: {
        get: async <T>(key: string) => this.ctx.storage.get<T>(key),
        put: async (entries: Record<string, unknown>) => this.ctx.storage.put(entries),
      },
      doStorage: {
        put: async (entries: Record<string, unknown>) => this.ctx.storage.put(entries),
        delete: async (key: string) => this.ctx.storage.delete(key),
      },
      isOperational: () => this.isSystemOperational(),
    });
  }
}
