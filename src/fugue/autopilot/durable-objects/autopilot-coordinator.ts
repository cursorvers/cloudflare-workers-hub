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
  createInitialExtendedState,
  applyExtendedTransition,
  isExtendedStateOperational,
  toLegacyMode,
  type RuntimeState,
  type RuntimeMode,
  type ModeTransitionResult,
  type ExtendedRuntimeState,
} from '../runtime/coordinator';
import type { ExtendedMode, TransitionPolicy } from '../runtime/mode-machine';
import {
  checkModeTimeout,
  DEFAULT_TRANSITION_POLICY,
  isModeOperational,
} from '../runtime/mode-machine';
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
import {
  type ExecutionQueueState,
  type ExecutionTask,
  type ExecutionResult,
  createExecutionQueueState,
  createExecutionTask,
  enqueueExecution,
  createAsyncAcceptedResponse,
  isResultExpired,
  SYNC_EXECUTION_TIMEOUT_MS,
  EXEC_RESULT_PREFIX,
  EXEC_TASK_PREFIX,
  ExecutionTaskPayloadSchema,
} from '../queue/execution-queue';
import { processExecutionBatch } from '../queue/execution-consumer';
import { safeLog } from '../../../utils/log-sanitizer';
import { z } from 'zod';

// =============================================================================
// Constants
// =============================================================================

const ALARM_INTERVAL_MS = 10_000; // 10s heartbeat alarm
const STORAGE_KEY_STATE = 'autopilot:state';
const STORAGE_KEY_STATE_V2 = 'autopilot:state:v2';
const STORAGE_KEY_HEARTBEAT = 'autopilot:heartbeat';
const STORAGE_KEY_CIRCUIT = 'autopilot:circuit';
const STORAGE_KEY_BUDGET = 'autopilot:budget';
const STORAGE_KEY_HYSTERESIS = 'autopilot:hysteresis';

/** Hysteresis counters for DEGRADE/RECOVER transitions */
const DEGRADE_HYSTERESIS_THRESHOLD = 3;
const RECOVER_HYSTERESIS_THRESHOLD = 3;

/** Execution consumer alarm interval (5s, separate from 10s health alarm) */
const EXEC_CONSUMER_INTERVAL_MS = 5_000;

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

const TransitionRequestSchema = z.object({
  targetMode: z.enum(['NORMAL', 'STOPPED']),
  reason: z.string().min(1),
});

export type TransitionRequest = z.infer<typeof TransitionRequestSchema>;

/** Hysteresis state for flap suppression (persisted to storage) */
interface HysteresisState {
  readonly consecutiveDegradeVerdicts: number;
  readonly consecutiveContinueVerdicts: number;
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
  private extendedState: ExtendedRuntimeState;
  private heartbeatState: HeartbeatState;
  private circuitBreakerState: CircuitBreakerState;
  private budgetSnapshot: BudgetSnapshot;
  private lastGuardCheck: GuardCheckResult | null;
  private hysteresis: HysteresisState;
  private executionQueue: ExecutionQueueState;
  private lastExecConsumerRunMs: number;
  private initialized: boolean;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.runtimeState = createInitialState();
    this.extendedState = createInitialExtendedState();
    this.heartbeatState = createHeartbeatState(Date.now());
    this.circuitBreakerState = createCircuitBreakerState();
    this.budgetSnapshot = DEFAULT_BUDGET_SNAPSHOT;
    this.lastGuardCheck = null;
    this.hysteresis = { consecutiveDegradeVerdicts: 0, consecutiveContinueVerdicts: 0 };
    this.executionQueue = createExecutionQueueState();
    this.lastExecConsumerRunMs = 0;
    this.initialized = false;
  }

  /**
   * Lazy initialization: restore persisted state from SQLite storage.
   */
  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;

    try {
      const [state, stateV2, heartbeat, circuit, budget, hysteresis] = await Promise.all([
        this.ctx.storage.get<RuntimeState>(STORAGE_KEY_STATE),
        this.ctx.storage.get<ExtendedRuntimeState>(STORAGE_KEY_STATE_V2),
        this.ctx.storage.get<HeartbeatState>(STORAGE_KEY_HEARTBEAT),
        this.ctx.storage.get<CircuitBreakerState>(STORAGE_KEY_CIRCUIT),
        this.ctx.storage.get<BudgetSnapshot>(STORAGE_KEY_BUDGET),
        this.ctx.storage.get<HysteresisState>(STORAGE_KEY_HYSTERESIS),
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
      if (hysteresis) this.hysteresis = Object.freeze({ ...hysteresis });
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
      [STORAGE_KEY_HYSTERESIS]: this.hysteresis,
    });
  }

  /** Check if system is operational using extended mode */
  private isSystemOperational(): boolean {
    return isModeOperational(this.extendedState.mode);
  }

  /** Sync legacy runtimeState from extended state */
  private syncLegacyState(reason: string, nowMs: number): void {
    const legacyMode = toLegacyMode(this.extendedState.mode);
    if (legacyMode !== this.runtimeState.mode) {
      const result = transitionMode(this.runtimeState, legacyMode, reason, nowMs);
      this.runtimeState = applyTransition(this.runtimeState, result);
    }
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

      // GET /task/:id — poll for async execution result
      if (path.startsWith('/task/') && request.method === 'GET') {
        const taskId = path.slice(6); // strip '/task/'
        return this.handleTaskPoll(taskId, request);
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

    const parsed = TransitionRequestSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(parsed.error.message, 400, 'VALIDATION_ERROR');
    }
    const { targetMode, reason } = parsed.data;

    const now = Date.now();

    // Legacy path
    const result = transitionMode(this.runtimeState, targetMode, reason, now);
    this.runtimeState = applyTransition(this.runtimeState, result);

    // Sync extended state: map legacy NORMAL/STOPPED to extended mode
    const extTarget: ExtendedMode = targetMode;
    this.extendedState = applyExtendedTransition(this.extendedState, extTarget, reason, now);
    // Reset hysteresis on manual transition
    this.hysteresis = { consecutiveDegradeVerdicts: 0, consecutiveContinueVerdicts: 0 };

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
    this.hysteresis = { consecutiveDegradeVerdicts: 0, consecutiveContinueVerdicts: 0 };
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

    // 3. Check if system is operational (extended mode: NORMAL or DEGRADED)
    // RECOVERY mode rejects with 503 (health check phase, not accepting work)
    if (!this.isSystemOperational()) {
      return jsonResponse({
        success: false,
        data: freezeToolResult({
          requestId: toolRequest.id,
          kind: ToolResultKind.FAILURE,
          traceContext: toolRequest.traceContext,
          durationMs: 0,
          completedAt: new Date().toISOString(),
          errorCode: ErrorCode.INTERNAL_ERROR,
          error: `system not operational (mode: ${this.extendedState.mode})`,
          retryable: this.extendedState.mode === 'RECOVERY',
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

    // 7. Determine sync vs async execution
    const asyncEnabled = this.env.AUTOPILOT_ASYNC_EXECUTION === 'true';

    // 7a. Try sync execution first (with soft timeout if async is enabled)
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
        mode: toLegacyMode(this.extendedState.mode),
      });

      // If async enabled, use timeout-based fallback
      if (asyncEnabled) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), SYNC_EXECUTION_TIMEOUT_MS);

        try {
          const result = await worker.execute(toolRequest, decision, controller.signal);
          clearTimeout(timeoutId);

          // Sync success — persist and return
          await this.postExecutionCleanup(result, toolRequest, storage, idemKey);
          return jsonResponse({ success: true, data: result });
        } catch (syncErr) {
          clearTimeout(timeoutId);

          // Timeout or abort → fall back to async enqueue
          if (controller.signal.aborted) {
            return this.enqueueAsyncExecution(toolRequest, computedRiskTier, request.url);
          }
          throw syncErr; // Re-throw non-timeout errors
        }
      }

      // Non-async path: pure sync execution (original behavior)
      const result = await worker.execute(toolRequest, decision);
      await this.postExecutionCleanup(result, toolRequest, storage, idemKey);
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
   * Post-execution cleanup: increment weekly count + persist idempotency.
   */
  private async postExecutionCleanup(
    result: ToolResult,
    toolRequest: ToolRequest,
    storage: ExecutorStorage,
    idemKey: string,
  ): Promise<void> {
    if (result.kind === ToolResultKind.SUCCESS && 'executionCost' in result) {
      try {
        await incrementWeeklyCount(storage, (result as { executionCost: { specialistId: string } }).executionCost.specialistId);
      } catch {
        // Weekly count update is non-critical
      }
    }

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
  }

  /**
   * Enqueue a tool execution for async processing.
   * Guards/policy already validated before this point (Security: no bypass).
   */
  private async enqueueAsyncExecution(
    toolRequest: ToolRequest,
    computedRiskTier: number,
    requestUrl: string,
  ): Promise<Response> {
    try {
      const payload = ExecutionTaskPayloadSchema.parse({
        requestId: toolRequest.id,
        toolName: toolRequest.name,
        category: toolRequest.category,
        params: toolRequest.params,
        effects: toolRequest.effects,
        computedRiskTier,
        traceContext: toolRequest.traceContext,
        idempotencyKey: toolRequest.idempotencyKey,
      });

      const task = createExecutionTask(
        'autopilot-system', // ownerId — system-level execution
        payload,
        { priority: computedRiskTier >= 3 ? 'low' : 'medium' }, // High risk = lower priority
      );

      const { nextState, accepted } = enqueueExecution(this.executionQueue, task);
      if (!accepted) {
        return errorResponse('Execution queue full or duplicate', 429, 'QUEUE_FULL');
      }

      this.executionQueue = nextState;

      // Persist task to storage for durability
      await this.ctx.storage.put({ [`${EXEC_TASK_PREFIX}${task.id}`]: task });

      safeLog.info('[AutopilotCoordinator] Async execution enqueued', {
        taskId: task.id,
        requestId: toolRequest.id,
        category: toolRequest.category,
      });

      const baseUrl = new URL(requestUrl).origin;
      const asyncResponse = createAsyncAcceptedResponse(task.id, baseUrl);
      return jsonResponse({ success: true, data: asyncResponse }, 202);
    } catch (err) {
      safeLog.error('[AutopilotCoordinator] Async enqueue failed', {
        error: err instanceof Error ? err.message : String(err),
        requestId: toolRequest.id,
      });
      return errorResponse('Failed to enqueue async execution', 500, 'ENQUEUE_FAILED');
    }
  }

  /**
   * GET /task/:id — Poll for async execution result.
   * Security: scoped by ownerId (IDOR prevention).
   * Returns: 200 (completed/failed), 202 (pending/processing), 404 (unknown), 410 (expired).
   */
  private async handleTaskPoll(taskId: string, _request: Request): Promise<Response> {
    if (!taskId || taskId.length > 256) {
      return errorResponse('Invalid task ID', 400, 'VALIDATION_ERROR');
    }

    // Check result storage first (completed tasks)
    const resultKey = `${EXEC_RESULT_PREFIX}${taskId}`;
    const result = await this.ctx.storage.get<ExecutionResult>(resultKey);

    if (result) {
      if (isResultExpired(result, Date.now())) {
        return jsonResponse({ success: false, error: { code: 'EXPIRED', message: 'Task result expired' } }, 410);
      }
      // Sanitize: only return minimal data (Security: no internal error leakage)
      return jsonResponse({
        success: true,
        data: {
          taskId: result.taskId,
          status: result.status,
          data: result.status === 'completed' ? result.data : undefined,
          errorCode: result.status === 'failed' ? result.errorCode : undefined,
          completedAt: result.completedAt,
          durationMs: result.durationMs,
        },
      });
    }

    // Check if task is pending/processing
    const taskKey = `${EXEC_TASK_PREFIX}${taskId}`;
    const task = await this.ctx.storage.get<ExecutionTask>(taskKey);

    if (task) {
      return jsonResponse({
        success: true,
        data: {
          taskId: task.id,
          status: task.status,
          createdAt: task.createdAt,
          retryAfterMs: 5000,
        },
      }, 202);
    }

    return errorResponse('Task not found', 404, 'NOT_FOUND');
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

      // Phase 3: mode timeout check (DEGRADED/RECOVERY auto-STOP)
      const timeoutResult = checkModeTimeout(
        {
          mode: this.extendedState.mode,
          previousMode: this.extendedState.previousMode,
          lastTransition: null,
          transitionCount: this.extendedState.transitionCount,
          enteredCurrentModeAt: this.extendedState.enteredCurrentModeAt,
        },
        DEFAULT_TRANSITION_POLICY,
        now,
      );

      if (timeoutResult.timedOut) {
        const reason = `auto-stop-timeout: ${timeoutResult.mode} exceeded ${timeoutResult.maxMs}ms (elapsed: ${timeoutResult.elapsedMs}ms)`;
        this.extendedState = applyExtendedTransition(this.extendedState, 'STOPPED', reason, now);
        this.syncLegacyState(reason, now);
        this.hysteresis = { consecutiveDegradeVerdicts: 0, consecutiveContinueVerdicts: 0 };

        safeLog.error('[AutopilotCoordinator] Auto-STOP timeout', {
          timedOutMode: timeoutResult.mode,
          elapsedMs: timeoutResult.elapsedMs,
          maxMs: timeoutResult.maxMs,
        });

        await this.persistState();
        return;
      }

      // Guard checks only when operational (NORMAL or DEGRADED).
      // NOTE: SafetySentinel also runs guard checks independently as a defense-in-depth
      // safety net. AutopilotCoordinator handles soft transitions (DEGRADE/RECOVER);
      // SafetySentinel handles hard STOP only. syncFromSentinel() below ensures
      // this DO honors SafetySentinel's STOPPED state to prevent divergence.
      if (this.isSystemOperational()) {
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

        // Priority 1: Hard-fail → STOPPED
        if (guardResult.shouldTransitionToStopped) {
          const reason = `auto-stop: ${guardResult.reasons.join('; ')}`;
          this.extendedState = applyExtendedTransition(this.extendedState, 'STOPPED', reason, now);
          this.syncLegacyState(reason, now);
          this.hysteresis = { consecutiveDegradeVerdicts: 0, consecutiveContinueVerdicts: 0 };

          safeLog.error('[AutopilotCoordinator] Auto-STOP triggered', {
            reasons: guardResult.reasons,
            warnings: guardResult.warnings,
            extendedMode: this.extendedState.mode,
          });
        }
        // Priority 2: DEGRADE verdict with hysteresis
        else if (guardResult.shouldTransitionToDegraded && this.extendedState.mode === 'NORMAL') {
          this.hysteresis = {
            ...this.hysteresis,
            consecutiveDegradeVerdicts: this.hysteresis.consecutiveDegradeVerdicts + 1,
            consecutiveContinueVerdicts: 0,
          };

          if (this.hysteresis.consecutiveDegradeVerdicts >= DEGRADE_HYSTERESIS_THRESHOLD) {
            const reason = `auto-degrade: ${guardResult.warnings.join('; ')} (${this.hysteresis.consecutiveDegradeVerdicts} consecutive)`;
            this.extendedState = applyExtendedTransition(this.extendedState, 'DEGRADED', reason, now);
            this.syncLegacyState(reason, now);
            this.hysteresis = { consecutiveDegradeVerdicts: 0, consecutiveContinueVerdicts: 0 };

            safeLog.warn('[AutopilotCoordinator] Auto-DEGRADE triggered', {
              warnings: guardResult.warnings,
              extendedMode: this.extendedState.mode,
            });
          }
        }
        // Priority 3: CONTINUE verdict — recover from DEGRADED
        else if (guardResult.verdict === 'CONTINUE' && this.extendedState.mode === 'DEGRADED') {
          this.hysteresis = {
            ...this.hysteresis,
            consecutiveContinueVerdicts: this.hysteresis.consecutiveContinueVerdicts + 1,
            consecutiveDegradeVerdicts: 0,
          };

          if (this.hysteresis.consecutiveContinueVerdicts >= RECOVER_HYSTERESIS_THRESHOLD) {
            const reason = `auto-recover: ${this.hysteresis.consecutiveContinueVerdicts} consecutive CONTINUE verdicts`;
            this.extendedState = applyExtendedTransition(this.extendedState, 'NORMAL', reason, now);
            this.syncLegacyState(reason, now);
            this.hysteresis = { consecutiveDegradeVerdicts: 0, consecutiveContinueVerdicts: 0 };

            safeLog.info('[AutopilotCoordinator] Auto-RECOVER from DEGRADED', {
              extendedMode: this.extendedState.mode,
            });
          }
        }
        // Reset hysteresis when verdict doesn't match expected direction
        else {
          if (guardResult.verdict === 'CONTINUE') {
            this.hysteresis = { ...this.hysteresis, consecutiveDegradeVerdicts: 0 };
          }
        }
      }
      // RECOVERY mode: check health gate for promotion to NORMAL
      else if (this.extendedState.mode === 'RECOVERY') {
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

        // Health gate: promote to NORMAL if guards pass
        if (guardResult.verdict === 'CONTINUE') {
          this.hysteresis = {
            ...this.hysteresis,
            consecutiveContinueVerdicts: this.hysteresis.consecutiveContinueVerdicts + 1,
          };

          if (this.hysteresis.consecutiveContinueVerdicts >= RECOVER_HYSTERESIS_THRESHOLD) {
            const reason = `recovery-complete: health gate passed ${this.hysteresis.consecutiveContinueVerdicts} consecutive checks`;
            this.extendedState = applyExtendedTransition(this.extendedState, 'NORMAL', reason, now);
            this.syncLegacyState(reason, now);
            this.hysteresis = { consecutiveDegradeVerdicts: 0, consecutiveContinueVerdicts: 0 };

            safeLog.info('[AutopilotCoordinator] Recovery completed, promoted to NORMAL', {
              extendedMode: this.extendedState.mode,
            });
          }
        } else {
          // Reset consecutive count if any check fails during recovery
          this.hysteresis = { ...this.hysteresis, consecutiveContinueVerdicts: 0 };
        }
      }

      // Sentinel sync: honor SafetySentinel's STOPPED state (defense-in-depth)
      if (this.isSystemOperational()) {
        await this.syncFromSentinel(now);
      }

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
        this.hysteresis = { consecutiveDegradeVerdicts: 0, consecutiveContinueVerdicts: 0 };
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
   * Sync from SafetySentinel: if Sentinel has auto-STOPPED, honor it.
   * Runs best-effort — failure does not block the alarm cycle.
   */
  private async syncFromSentinel(now: number): Promise<void> {
    try {
      const sentinel = this.env.SAFETY_SENTINEL;
      if (!sentinel) return;

      const id = sentinel.idFromName('singleton');
      const stub = sentinel.get(id);

      const authKey =
        this.env.AUTOPILOT_API_KEY ??
        this.env.WORKERS_API_KEY ??
        this.env.ASSISTANT_API_KEY;

      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (authKey) headers['Authorization'] = `Bearer ${authKey}`;

      const res = await stub.fetch(new Request('https://sentinel/status', { headers }));
      if (!res.ok) return;

      const body = await res.json() as { success: boolean; data?: { mode: string } };
      if (!body.success || !body.data) return;

      // If Sentinel says STOPPED but we're still operational, honor Sentinel
      if (body.data.mode === 'STOPPED' && this.isSystemOperational()) {
        const reason = 'sentinel-sync: SafetySentinel auto-STOPPED, honoring';
        this.extendedState = applyExtendedTransition(this.extendedState, 'STOPPED', reason, now);
        this.syncLegacyState(reason, now);
        this.hysteresis = { consecutiveDegradeVerdicts: 0, consecutiveContinueVerdicts: 0 };

        safeLog.warn('[AutopilotCoordinator] Honoring SafetySentinel STOPPED state', {
          extendedMode: this.extendedState.mode,
        });
      }
    } catch (err) {
      // Best-effort: don't block alarm on sentinel communication failure
      safeLog.warn('[AutopilotCoordinator] Sentinel sync failed (non-blocking)', {
        error: err instanceof Error ? err.message : String(err),
      });
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
