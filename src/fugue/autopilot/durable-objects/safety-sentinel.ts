/**
 * SafetySentinel Durable Object
 *
 * Safety Plane: owns alarm-driven guard checks, heartbeat recording,
 * circuit breaker state, and auto-STOP logic.
 *
 * Separated from AutopilotCoordinator (API Facade / Management Plane).
 * Fail-closed: any unhandled alarm error transitions to STOPPED.
 */

import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../../../types';
import {
  createInitialState,
  transitionMode,
  applyTransition,
  isOperational,
  type RuntimeState,
  type RuntimeMode,
} from '../runtime/coordinator';
import {
  runGuardCheck,
  type GuardInput,
  type GuardCheckResult,
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
import { safeLog } from '../../../utils/log-sanitizer';
import type {
  SentinelStatus,
  SentinelBudgetUpdate,
  SentinelGuardResult,
} from './safety-sentinel-types';

// =============================================================================
// Constants
// =============================================================================

const ALARM_INTERVAL_MS = 10_000; // 10s heartbeat alarm
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute sliding window
const RATE_LIMIT_MAX_REQUESTS = 120; // max requests per window
const STORAGE_KEY_STATE = 'sentinel:state';
const STORAGE_KEY_HEARTBEAT = 'sentinel:heartbeat';
const STORAGE_KEY_CIRCUIT = 'sentinel:circuit';
const STORAGE_KEY_BUDGET_SPENT = 'sentinel:budget:spent';
const STORAGE_KEY_BUDGET_LIMIT = 'sentinel:budget:limit';

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

// =============================================================================
// Durable Object
// =============================================================================

export class SafetySentinel extends DurableObject<Env> {
  private runtimeState: RuntimeState;
  private heartbeatState: HeartbeatState;
  private circuitBreakerState: CircuitBreakerState;
  private budgetSpent: number;
  private budgetLimit: number;
  private lastGuardCheck: GuardCheckResult | null;
  private initialized: boolean;
  private requestTimestamps: number[];

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.runtimeState = createInitialState();
    this.heartbeatState = createHeartbeatState(Date.now());
    this.circuitBreakerState = createCircuitBreakerState();
    this.budgetSpent = 0;
    this.budgetLimit = 200;
    this.lastGuardCheck = null;
    this.initialized = false;
    this.requestTimestamps = [];
  }

  // ===========================================================================
  // Initialization
  // ===========================================================================

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;

    try {
      const [state, heartbeat, circuit, spent, limit] = await Promise.all([
        this.ctx.storage.get<RuntimeState>(STORAGE_KEY_STATE),
        this.ctx.storage.get<HeartbeatState>(STORAGE_KEY_HEARTBEAT),
        this.ctx.storage.get<CircuitBreakerState>(STORAGE_KEY_CIRCUIT),
        this.ctx.storage.get<number>(STORAGE_KEY_BUDGET_SPENT),
        this.ctx.storage.get<number>(STORAGE_KEY_BUDGET_LIMIT),
      ]);

      if (state) this.runtimeState = Object.freeze({ ...state });
      if (heartbeat) this.heartbeatState = Object.freeze({ ...heartbeat });
      if (circuit) this.circuitBreakerState = Object.freeze({ ...circuit });
      if (typeof spent === 'number') this.budgetSpent = spent;
      if (typeof limit === 'number') this.budgetLimit = limit;
    } catch (err) {
      safeLog.error('[SafetySentinel] Storage restore failed (fail-closed)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    this.initialized = true;
    await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
  }

  private async persistState(): Promise<void> {
    await this.ctx.storage.put({
      [STORAGE_KEY_STATE]: this.runtimeState,
      [STORAGE_KEY_HEARTBEAT]: this.heartbeatState,
      [STORAGE_KEY_CIRCUIT]: this.circuitBreakerState,
      [STORAGE_KEY_BUDGET_SPENT]: this.budgetSpent,
      [STORAGE_KEY_BUDGET_LIMIT]: this.budgetLimit,
    });
  }

  // ===========================================================================
  // HTTP API (called by AutopilotCoordinator or directly)
  // ===========================================================================

  async fetch(request: Request): Promise<Response> {
    // Verify internal bearer token (defense-in-depth)
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

    // In-memory sliding window rate limit
    const now = Date.now();
    this.requestTimestamps = this.requestTimestamps.filter(
      (t) => now - t < RATE_LIMIT_WINDOW_MS,
    );
    if (this.requestTimestamps.length >= RATE_LIMIT_MAX_REQUESTS) {
      return errorResponse('Too many requests', 429, 'RATE_LIMITED');
    }
    this.requestTimestamps = [...this.requestTimestamps, now];

    await this.ensureInitialized();

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === '/status' && request.method === 'GET') {
        return this.handleStatus();
      }

      if (path === '/guard' && request.method === 'POST') {
        return this.handleGuardCheck();
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

      if (path === '/transition' && request.method === 'POST') {
        return this.handleTransition(request);
      }

      return errorResponse('Not found', 404, 'NOT_FOUND');
    } catch (err) {
      safeLog.error('[SafetySentinel] Request error', {
        error: err instanceof Error ? err.message : String(err),
        path,
      });
      return errorResponse('Internal error', 500, 'INTERNAL_ERROR');
    }
  }

  // ===========================================================================
  // Route Handlers
  // ===========================================================================

  private handleStatus(): Response {
    const status: SentinelStatus = Object.freeze({
      mode: this.runtimeState.mode,
      isOperational: isOperational(this.runtimeState),
      lastGuardCheck: this.lastGuardCheck,
      heartbeatState: this.heartbeatState,
      circuitBreakerState: this.circuitBreakerState,
      budgetSpent: this.budgetSpent,
      budgetLimit: this.budgetLimit,
      timestamp: Date.now(),
    });
    return jsonResponse({ success: true, data: status });
  }

  private async handleGuardCheck(): Promise<Response> {
    const now = Date.now();

    const guardInput: GuardInput = {
      budget: { spent: this.budgetSpent, limit: this.budgetLimit },
      circuitBreaker: { state: this.circuitBreakerState },
      heartbeat: { state: this.heartbeatState },
    };

    const guardResult = runGuardCheck(guardInput, now);
    this.lastGuardCheck = guardResult;

    let autoStopped = false;
    let transition = null;

    if (guardResult.shouldTransitionToStopped && isOperational(this.runtimeState)) {
      const stopResult = transitionMode(
        this.runtimeState,
        'STOPPED',
        `auto-stop: ${guardResult.reasons.join('; ')}`,
        now,
      );
      this.runtimeState = applyTransition(this.runtimeState, stopResult);
      autoStopped = true;
      transition = stopResult;

      safeLog.error('[SafetySentinel] Auto-STOP triggered', {
        reasons: guardResult.reasons,
        warnings: guardResult.warnings,
      });
    }

    await this.persistState();

    const result: SentinelGuardResult = Object.freeze({
      guardCheck: guardResult,
      autoStopped,
      transition,
    });

    return jsonResponse({ success: true, data: result });
  }

  private async handleHeartbeat(): Promise<Response> {
    const now = Date.now();
    this.heartbeatState = recordHeartbeat(this.heartbeatState, now);
    await this.persistState();
    return jsonResponse({
      success: true,
      data: { heartbeatState: this.heartbeatState, timestamp: now },
    });
  }

  private async handleBudgetUpdate(request: Request): Promise<Response> {
    const body = await request.json().catch(() => null);
    if (!body) return errorResponse('Invalid JSON', 400, 'INVALID_BODY');

    const { spent, limit } = body as SentinelBudgetUpdate;
    if (typeof spent !== 'number' || typeof limit !== 'number') {
      return errorResponse('spent and limit must be numbers', 400, 'VALIDATION_ERROR');
    }

    this.budgetSpent = spent;
    this.budgetLimit = limit;
    await this.persistState();

    return jsonResponse({
      success: true,
      data: { spent: this.budgetSpent, limit: this.budgetLimit, updatedAt: Date.now() },
    });
  }

  private async handleCircuitSuccess(): Promise<Response> {
    this.circuitBreakerState = cbRecordSuccess(this.circuitBreakerState);
    await this.persistState();
    return jsonResponse({
      success: true,
      data: { circuitBreakerState: this.circuitBreakerState },
    });
  }

  private async handleCircuitFailure(): Promise<Response> {
    const now = Date.now();
    this.circuitBreakerState = cbRecordFailure(this.circuitBreakerState, undefined, now);
    await this.persistState();
    return jsonResponse({
      success: true,
      data: { circuitBreakerState: this.circuitBreakerState },
    });
  }

  private async handleTransition(request: Request): Promise<Response> {
    const body = await request.json().catch(() => null);
    if (!body) return errorResponse('Invalid JSON', 400, 'INVALID_BODY');

    const { targetMode, reason } = body as { targetMode: RuntimeMode; reason: string };
    if (!targetMode || !reason) {
      return errorResponse('targetMode and reason required', 400, 'VALIDATION_ERROR');
    }

    const result = transitionMode(this.runtimeState, targetMode, reason);
    this.runtimeState = applyTransition(this.runtimeState, result);

    // Reset circuit breaker on recovery to NORMAL
    if (result.success && result.currentMode === 'NORMAL' && result.previousMode === 'STOPPED') {
      this.circuitBreakerState = createCircuitBreakerState();
    }

    await this.persistState();

    safeLog.info('[SafetySentinel] Mode transition', {
      from: result.previousMode,
      to: result.currentMode,
      success: result.success,
      reason: result.reason,
    });

    return jsonResponse({ success: true, data: result });
  }

  // ===========================================================================
  // Alarm Handler
  // ===========================================================================

  async alarm(): Promise<void> {
    try {
      await this.ensureInitialized();

      const now = Date.now();
      this.heartbeatState = recordHeartbeat(this.heartbeatState, now);

      if (isOperational(this.runtimeState)) {
        const guardInput: GuardInput = {
          budget: { spent: this.budgetSpent, limit: this.budgetLimit },
          circuitBreaker: { state: this.circuitBreakerState },
          heartbeat: { state: this.heartbeatState },
        };

        const guardResult = runGuardCheck(guardInput, now);
        this.lastGuardCheck = guardResult;

        if (guardResult.shouldTransitionToStopped) {
          const stopResult = transitionMode(
            this.runtimeState,
            'STOPPED',
            `auto-stop: ${guardResult.reasons.join('; ')}`,
            now,
          );
          this.runtimeState = applyTransition(this.runtimeState, stopResult);

          safeLog.error('[SafetySentinel] Auto-STOP triggered by alarm', {
            reasons: guardResult.reasons,
            warnings: guardResult.warnings,
          });
        }
      }

      await this.persistState();
    } catch (err) {
      safeLog.error('[SafetySentinel] Alarm error (fail-closed)', {
        error: err instanceof Error ? err.message : String(err),
      });

      try {
        const failResult = transitionMode(
          this.runtimeState,
          'STOPPED',
          `fail-closed: alarm error (${err instanceof Error ? err.message : 'unknown'})`,
        );
        this.runtimeState = applyTransition(this.runtimeState, failResult);
        await this.persistState();
      } catch (persistErr) {
        safeLog.error('[SafetySentinel] Failed to persist fail-closed state', {
          error: persistErr instanceof Error ? persistErr.message : String(persistErr),
        });
      }
    } finally {
      try {
        await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
      } catch (alarmErr) {
        safeLog.error('[SafetySentinel] Failed to schedule alarm', {
          error: alarmErr instanceof Error ? alarmErr.message : String(alarmErr),
        });
      }
    }
  }
}
