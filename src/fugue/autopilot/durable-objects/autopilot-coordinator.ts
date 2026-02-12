/**
 * AutopilotCoordinator Durable Object
 *
 * Management Plane for 24h autonomous runtime safety.
 * Wraps Phase 1 pure functions (coordinator, runtime-guard, heartbeat, etc.)
 * into an alarm-driven Durable Object with HTTP API.
 *
 * Separated from RunCoordinator (Data Plane: orchestration runs/steps).
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
  type ModeTransitionResult,
} from '../runtime/coordinator';
import {
  runGuardCheck,
  evaluateRecovery,
  type GuardInput,
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
import { evaluatePolicy } from '../policy/engine';
import { DEFAULT_RULES } from '../policy/rules';
import type { PolicyContext, PolicyDecision } from '../policy/types';
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
import { safeLog } from '../../../utils/log-sanitizer';

// =============================================================================
// Constants
// =============================================================================

const ALARM_INTERVAL_MS = 10_000; // 10s heartbeat alarm
const STORAGE_KEY_STATE = 'autopilot:state';
const STORAGE_KEY_HEARTBEAT = 'autopilot:heartbeat';
const STORAGE_KEY_CIRCUIT = 'autopilot:circuit';
const STORAGE_KEY_BUDGET = 'autopilot:budget';

/** Idempotency key prefix and TTL (1 hour) */
const IDEMPOTENCY_PREFIX = 'autopilot:idem:';
const IDEMPOTENCY_TTL_MS = 60 * 60 * 1000;

interface IdempotencyEntry {
  readonly result: unknown;
  readonly expiresAt: number;
}

// =============================================================================
// Types
// =============================================================================

export interface AutopilotStatus {
  readonly mode: RuntimeMode;
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
  private heartbeatState: HeartbeatState;
  private circuitBreakerState: CircuitBreakerState;
  private budgetSnapshot: BudgetSnapshot;
  private lastGuardCheck: GuardCheckResult | null;
  private initialized: boolean;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.runtimeState = createInitialState();
    this.heartbeatState = createHeartbeatState(Date.now());
    this.circuitBreakerState = createCircuitBreakerState();
    this.budgetSnapshot = DEFAULT_BUDGET_SNAPSHOT;
    this.lastGuardCheck = null;
    this.initialized = false;
  }

  /**
   * Lazy initialization: restore persisted state from SQLite storage.
   */
  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;

    try {
      const [state, heartbeat, circuit, budget] = await Promise.all([
        this.ctx.storage.get<RuntimeState>(STORAGE_KEY_STATE),
        this.ctx.storage.get<HeartbeatState>(STORAGE_KEY_HEARTBEAT),
        this.ctx.storage.get<CircuitBreakerState>(STORAGE_KEY_CIRCUIT),
        this.ctx.storage.get<BudgetSnapshot>(STORAGE_KEY_BUDGET),
      ]);

      if (state) this.runtimeState = Object.freeze({ ...state });
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
    await this.ctx.storage.put({
      [STORAGE_KEY_STATE]: this.runtimeState,
      [STORAGE_KEY_HEARTBEAT]: this.heartbeatState,
      [STORAGE_KEY_CIRCUIT]: this.circuitBreakerState,
      [STORAGE_KEY_BUDGET]: this.budgetSnapshot,
    });
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
        return this.handleExecute(request);
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
      isOperational: isOperational(this.runtimeState),
      transitionCount: this.runtimeState.transitionCount,
      lastTransition: this.runtimeState.lastTransition,
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

    const result = transitionMode(this.runtimeState, targetMode, reason);
    this.runtimeState = applyTransition(this.runtimeState, result);
    await this.persistState();

    safeLog.info('[AutopilotCoordinator] Mode transition', {
      from: result.previousMode,
      to: result.currentMode,
      success: result.success,
      reason: result.reason,
    });

    return jsonResponse({ success: true, data: result });
  }

  /** POST /recovery */
  private async handleRecovery(request: Request): Promise<Response> {
    const body = await request.json().catch(() => null);
    if (!body) return errorResponse('Request body must be valid JSON', 400, 'INVALID_BODY');

    const recoveryRequest = body as RecoveryRequest;
    const recoveryResult: RecoveryResult = evaluateRecovery(recoveryRequest);

    if (!recoveryResult.allowed) {
      return jsonResponse({ success: false, data: recoveryResult }, 403);
    }

    const result = transitionMode(
      this.runtimeState,
      'NORMAL',
      `recovery: ${recoveryResult.reason}`,
    );
    this.runtimeState = applyTransition(this.runtimeState, result);
    this.circuitBreakerState = createCircuitBreakerState();
    await this.persistState();

    safeLog.info('[AutopilotCoordinator] Recovery completed', {
      approvedBy: recoveryRequest.approvedBy,
      reason: recoveryRequest.reason,
      mode: this.runtimeState.mode,
    });

    return jsonResponse({
      success: true,
      data: { recovery: recoveryResult, transition: result },
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

  /**
   * POST /execute — Execute a tool request through the full pipeline.
   *
   * Flow: validate → compute policy (server-side) → route → execute → persist CB → return result
   * Security: PolicyDecision is NEVER accepted from the client.
   */
  private async handleExecute(request: Request): Promise<Response> {
    // 1. Body size check
    const contentLength = parseInt(request.headers.get('content-length') ?? '0', 10);
    if (contentLength > MAX_EXECUTE_BODY_SIZE) {
      return errorResponse('Request body too large', 413, 'PAYLOAD_TOO_LARGE');
    }

    // 2. Parse and validate
    let bodyText: string;
    try {
      bodyText = await request.text();
      // Use byte length for accurate size check (multi-byte chars)
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

    // 3. Check if system is operational
    if (!isOperational(this.runtimeState)) {
      return jsonResponse({
        success: false,
        data: freezeToolResult({
          requestId: toolRequest.id,
          kind: ToolResultKind.FAILURE,
          traceContext: toolRequest.traceContext,
          durationMs: 0,
          completedAt: new Date().toISOString(),
          errorCode: ErrorCode.INTERNAL_ERROR,
          error: `system not operational (mode: ${this.runtimeState.mode})`,
          retryable: false,
        }),
      }, 503);
    }

    // 4. Idempotency check — return cached result for duplicate requests
    const idemKey = `${IDEMPOTENCY_PREFIX}${toolRequest.idempotencyKey}`;
    const cachedEntry = await this.ctx.storage.get<IdempotencyEntry>(idemKey);
    if (cachedEntry && cachedEntry.expiresAt > Date.now()) {
      return jsonResponse({ success: true, data: cachedEntry.result });
    }

    // 5. Server-side risk re-classification (CRITICAL: never trust client riskTier/effects)
    const knownEffectSet = new Set<string>(Object.values(EFFECT_TYPES));
    const validatedEffects: readonly EffectType[] = Object.freeze(
      toolRequest.effects.filter((e): e is EffectType => knownEffectSet.has(e)),
    );
    const hasUnknownEffects = validatedEffects.length !== toolRequest.effects.length;

    // Phase 2 strict mode: reject unknown effects with 400
    const strictEffects = this.env.AUTOPILOT_STRICT_EFFECTS === 'true';
    if (hasUnknownEffects && strictEffects) {
      const unknownEffects = toolRequest.effects.filter((e) => !knownEffectSet.has(e));
      return errorResponse(
        `Unknown effects rejected: ${unknownEffects.join(', ')}`,
        400,
        'INVALID_EFFECTS',
      );
    }

    // Unknown effects → max risk tier; otherwise compute from category + effects
    const computedRiskTier = hasUnknownEffects
      ? 4 as const
      : classifyRisk({ effects: validatedEffects, category: toolRequest.category, origin: ORIGINS.INTERNAL });

    if (toolRequest.riskTier !== computedRiskTier) {
      safeLog.warn('[AutopilotCoordinator] Risk tier mismatch (client overridden)', {
        requestId: toolRequest.id,
        clientRiskTier: toolRequest.riskTier,
        computedRiskTier,
        category: toolRequest.category,
        clientEffects: toolRequest.effects,
        validatedEffects,
      });
    }

    // 6. Compute policy decision server-side
    const budgetState = this.budgetSnapshot.spent >= this.budgetSnapshot.limit
      ? BUDGET_STATES.HALTED
      : this.budgetSnapshot.spent >= this.budgetSnapshot.limit * 0.8
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

    // 7. Create executor worker via factory
    const storage: ExecutorStorage = {
      get: async <T>(key: string) => this.ctx.storage.get<T>(key),
      put: async (entries: Record<string, unknown>) => this.ctx.storage.put(entries),
    };

    try {
      const { worker } = await createExecutorWorker({
        env: {
          OPENAI_API_KEY: this.env.OPENAI_API_KEY,
          ZAI_API_KEY: this.env.ZAI_API_KEY,
          GEMINI_API_KEY: this.env.GEMINI_API_KEY,
        },
        storage,
        mode: this.runtimeState.mode === 'NORMAL' ? 'NORMAL' : 'STOPPED',
      });

      // 8. Execute
      const result = await worker.execute(toolRequest, decision);

      // 9. Post-execution: increment weekly count + persist idempotency entry
      if (result.kind === ToolResultKind.SUCCESS && 'executionCost' in result) {
        try {
          await incrementWeeklyCount(storage, result.executionCost.specialistId);
        } catch {
          // Weekly count update is non-critical
        }
      }

      // Persist idempotency entry (fire-and-forget, non-critical)
      try {
        const entry: IdempotencyEntry = Object.freeze({
          result,
          expiresAt: Date.now() + IDEMPOTENCY_TTL_MS,
        });
        await this.ctx.storage.put({ [idemKey]: entry });
      } catch {
        // Idempotency cache is non-critical
      }

      safeLog.info('[AutopilotCoordinator] Tool execution completed', {
        requestId: toolRequest.id,
        kind: result.kind,
        category: toolRequest.category,
      });

      return jsonResponse({ success: true, data: result });
    } catch (err) {
      safeLog.error('[AutopilotCoordinator] Execute error', {
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

  /**
   * Alarm handler: periodic guard check + auto-STOP.
   * Fail-closed: any error -> STOPPED.
   */
  async alarm(): Promise<void> {
    try {
      await this.ensureInitialized();

      const now = Date.now();
      this.heartbeatState = recordHeartbeat(this.heartbeatState, now);

      if (isOperational(this.runtimeState)) {
        const guardInput: GuardInput = {
          budget: {
            spent: this.budgetSnapshot.spent,
            limit: this.budgetSnapshot.limit,
          },
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

          safeLog.error('[AutopilotCoordinator] Auto-STOP triggered', {
            reasons: guardResult.reasons,
            warnings: guardResult.warnings,
          });
        }
      }

      await this.persistState();
    } catch (err) {
      safeLog.error('[AutopilotCoordinator] Alarm error (fail-closed)', {
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
}
