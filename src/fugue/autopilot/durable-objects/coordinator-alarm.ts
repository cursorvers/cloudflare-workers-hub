/**
 * Coordinator Alarm Pipeline — RuntimeGateway facade for alarm-driven logic.
 *
 * Extracted from AutopilotCoordinator to:
 * 1. Keep DO under 800 lines
 * 2. Provide plugin points for v1.3 module connections
 *    (reconciliation, provider probe, dedup, audit chain, TTL cleanup)
 *
 * All alarm logic flows through processAlarmTick().
 * Fail-closed: errors result in STOPPED transition.
 */

import type { ExtendedRuntimeState } from '../runtime/coordinator';
import {
  applyExtendedTransition,
  toLegacyMode,
  transitionMode,
  applyTransition,
  type RuntimeState,
} from '../runtime/coordinator';
import type { ExtendedMode } from '../runtime/mode-machine';
import {
  checkModeTimeout,
  DEFAULT_TRANSITION_POLICY,
  isModeOperational,
} from '../runtime/mode-machine';
import {
  runGuardCheck,
  type GuardInput,
  type GuardCheckResult,
} from '../runtime/runtime-guard';
import {
  recordHeartbeat,
  type HeartbeatState,
} from '../runtime/heartbeat';
import type { CircuitBreakerState } from '../runtime/circuit-breaker';
import type { BudgetSnapshot } from './autopilot-coordinator';
import {
  type MetricsState,
  recordModeTransition as metricsRecordTransition,
  recordGuardVerdict as metricsRecordVerdict,
} from '../metrics/collector';
import {
  type HealthProbeState,
  isProbeOverdue,
  probeProvider,
  recordProbeResult,
  type ProviderId,
  PROVIDER_IDS,
} from '../health/provider-probe';
import {
  reconcileState,
  type ReconciliationInput,
} from '../state/reconciliation';
import {
  type DedupState,
  type DedupDecision,
  computeFingerprint,
  checkDedup,
  cleanupExpired,
} from '../notify/notification-dedup';
import type { NotificationType } from '../notify/notification-dispatcher';
import {
  IDEMPOTENCY_PREFIX,
  IDEMPOTENCY_TTL_MS,
  type IdempotencyEntry,
} from './coordinator-execute';
import {
  EXEC_RESULT_PREFIX,
  type ExecutionResult,
  isResultExpired,
} from '../queue/execution-queue';
import { safeLog } from '../../../utils/log-sanitizer';

// =============================================================================
// Constants
// =============================================================================

const DEGRADE_HYSTERESIS_THRESHOLD = 3;
const RECOVER_HYSTERESIS_THRESHOLD = 3;

/** TTL cleanup interval: scan for expired idempotency/result entries every 5 minutes */
const TTL_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

// =============================================================================
// Types
// =============================================================================

/** Hysteresis state for flap suppression */
export interface HysteresisState {
  consecutiveDegradeVerdicts: number;
  consecutiveContinueVerdicts: number;
}

export const INITIAL_HYSTERESIS: HysteresisState = Object.freeze({
  consecutiveDegradeVerdicts: 0,
  consecutiveContinueVerdicts: 0,
});

/** Mutable state container — alarm pipeline reads/writes through this */
export interface AlarmPipelineState {
  runtimeState: RuntimeState;
  extendedState: ExtendedRuntimeState;
  heartbeatState: HeartbeatState;
  circuitBreakerState: CircuitBreakerState;
  budgetSnapshot: BudgetSnapshot;
  lastGuardCheck: GuardCheckResult | null;
  hysteresis: HysteresisState;
  metricsState: MetricsState;
  healthProbeState: HealthProbeState;
  dedupState: DedupState;
  lastTtlCleanupMs: number;
}

/** Storage abstraction for reconciliation, probing, and TTL cleanup */
export interface AlarmPipelineStorage {
  get: <T>(key: string) => Promise<T | undefined>;
  put: (entries: Record<string, unknown>) => Promise<void>;
  list: <T>(prefix: string) => Promise<Map<string, T> | undefined>;
  deleteKeys: (keys: string[]) => Promise<void>;
}

/** API keys for provider probing */
export interface AlarmPipelineApiKeys {
  readonly OPENAI_API_KEY?: string;
  readonly ZAI_API_KEY?: string;
  readonly GEMINI_API_KEY?: string;
}

/** Audit callback for writing WORM hash-chain entries */
export interface AlarmPipelineAudit {
  readonly modeTransition: (previousMode: string, newMode: string, reason: string) => Promise<boolean>;
  readonly guardCheck: (verdict: string, reasons: readonly string[], warnings: readonly string[]) => Promise<boolean>;
  readonly autoStop: (previousMode: string, reasons: readonly string[]) => Promise<boolean>;
}

/** Result of a single alarm tick */
export interface AlarmTickResult {
  readonly transitioned: boolean;
  readonly newMode: ExtendedMode;
  readonly reason?: string;
  readonly reconciled: boolean;
  readonly probed: boolean;
  readonly dedupDecisions: readonly DedupDecision[];
  readonly ttlCleanedUp: number;
}

// =============================================================================
// Storage keys for reconciliation
// =============================================================================

const STORAGE_KEY_STATE_V2 = 'autopilot:state:v2';
const STORAGE_KEY_HEARTBEAT = 'autopilot:heartbeat';
const STORAGE_KEY_CIRCUIT = 'autopilot:circuit';
const STORAGE_KEY_BUDGET = 'autopilot:budget';

// =============================================================================
// Alarm Pipeline (main entry point)
// =============================================================================

/**
 * Process a single alarm tick. Returns the result of the tick.
 * Modifies state in-place through the mutable AlarmPipelineState container.
 */
export async function processAlarmTick(
  state: AlarmPipelineState,
  storage: AlarmPipelineStorage,
  apiKeys: AlarmPipelineApiKeys,
  nowMs: number,
  audit?: AlarmPipelineAudit,
): Promise<AlarmTickResult> {
  let transitioned = false;
  let reason: string | undefined;
  let reconciled = false;
  let probed = false;
  let ttlCleanedUp = 0;
  const dedupDecisions: DedupDecision[] = [];

  // 1. Heartbeat
  state.heartbeatState = recordHeartbeat(state.heartbeatState, nowMs);

  // 2. State reconciliation (v1.3: detect drift on every tick)
  reconciled = await runReconciliation(state, storage, nowMs);

  // 3. Mode timeout check (DEGRADED/RECOVERY auto-STOP)
  const timeoutResult = checkModeTimeout(
    {
      mode: state.extendedState.mode,
      previousMode: state.extendedState.previousMode,
      lastTransition: null,
      transitionCount: state.extendedState.transitionCount,
      enteredCurrentModeAt: state.extendedState.enteredCurrentModeAt,
    },
    DEFAULT_TRANSITION_POLICY,
    nowMs,
  );

  if (timeoutResult.timedOut) {
    reason = `auto-stop-timeout: ${timeoutResult.mode} exceeded ${timeoutResult.maxMs}ms (elapsed: ${timeoutResult.elapsedMs}ms)`;
    const prevMode = state.extendedState.mode;
    const dedup = checkModeChangeDedup(state, 'auto_stop', reason, nowMs);
    dedupDecisions.push(dedup);
    applyModeChange(state, 'STOPPED', reason, nowMs);
    state.metricsState = metricsRecordTransition(state.metricsState, {
      from: timeoutResult.mode ?? 'UNKNOWN', to: 'STOPPED', reason, timestamp: nowMs,
    });
    // WORM audit: record mode transition
    if (audit) await audit.autoStop(prevMode, [reason]).catch(() => {});
    safeLog.error('[AlarmPipeline] Auto-STOP timeout', {
      timedOutMode: timeoutResult.mode, elapsedMs: timeoutResult.elapsedMs,
      notifySuppressed: !dedup.shouldNotify,
    });
    state.dedupState = cleanupExpired(state.dedupState, nowMs);
    return { transitioned: true, newMode: 'STOPPED', reason, reconciled, probed, dedupDecisions, ttlCleanedUp };
  }

  // 4. Provider health probing (every PROBE_INTERVAL_MS)
  if (isProbeOverdue(state.healthProbeState, nowMs)) {
    probed = true;
    await runProviderProbes(state, apiKeys);
  }

  // 5. Guard checks (mode-dependent)
  if (isModeOperational(state.extendedState.mode)) {
    const result = await processOperationalGuard(state, nowMs, dedupDecisions, audit);
    transitioned = result.transitioned;
    reason = result.reason;
  } else if (state.extendedState.mode === 'RECOVERY') {
    const result = await processRecoveryGuard(state, nowMs, dedupDecisions, audit);
    transitioned = result.transitioned;
    reason = result.reason;
  }

  // 6. Dedup cleanup (prevent unbounded growth)
  state.dedupState = cleanupExpired(state.dedupState, nowMs);

  // 7. TTL cleanup: expired idempotency keys + task results (every 5 min)
  if (nowMs - state.lastTtlCleanupMs >= TTL_CLEANUP_INTERVAL_MS) {
    ttlCleanedUp = await runTtlCleanup(storage, nowMs);
    state.lastTtlCleanupMs = nowMs;
  }

  return {
    transitioned,
    newMode: state.extendedState.mode,
    reason,
    reconciled,
    probed,
    dedupDecisions,
    ttlCleanedUp,
  };
}

// =============================================================================
// Guard processing (operational modes)
// =============================================================================

async function processOperationalGuard(
  state: AlarmPipelineState,
  nowMs: number,
  dedupDecisions: DedupDecision[],
  audit?: AlarmPipelineAudit,
): Promise<{ transitioned: boolean; reason?: string }> {
  const guardInput = buildGuardInput(state);
  const guardResult = runGuardCheck(guardInput, nowMs);
  state.lastGuardCheck = guardResult;
  state.metricsState = metricsRecordVerdict(state.metricsState, {
    verdict: guardResult.verdict, reasons: guardResult.reasons, timestamp: nowMs,
  });

  // WORM audit: record every guard check
  if (audit) await audit.guardCheck(guardResult.verdict, guardResult.reasons, guardResult.warnings).catch(() => {});

  // Priority 1: Hard-fail → STOPPED
  if (guardResult.shouldTransitionToStopped) {
    const prevMode = state.extendedState.mode;
    const reason = `auto-stop: ${guardResult.reasons.join('; ')}`;
    const dedup = checkModeChangeDedup(state, 'auto_stop', reason, nowMs);
    dedupDecisions.push(dedup);
    applyModeChange(state, 'STOPPED', reason, nowMs);
    state.metricsState = metricsRecordTransition(state.metricsState, {
      from: 'OPERATIONAL', to: 'STOPPED', reason, timestamp: nowMs,
    });
    if (audit) await audit.autoStop(prevMode, guardResult.reasons).catch(() => {});
    safeLog.error('[AlarmPipeline] Auto-STOP triggered', {
      reasons: guardResult.reasons, extendedMode: state.extendedState.mode,
      notifySuppressed: !dedup.shouldNotify,
    });
    return { transitioned: true, reason };
  }

  // Priority 2: DEGRADE with hysteresis
  if (guardResult.shouldTransitionToDegraded && state.extendedState.mode === 'NORMAL') {
    state.hysteresis = {
      ...state.hysteresis,
      consecutiveDegradeVerdicts: state.hysteresis.consecutiveDegradeVerdicts + 1,
      consecutiveContinueVerdicts: 0,
    };

    if (state.hysteresis.consecutiveDegradeVerdicts >= DEGRADE_HYSTERESIS_THRESHOLD) {
      const reason = `auto-degrade: ${guardResult.warnings.join('; ')} (${state.hysteresis.consecutiveDegradeVerdicts} consecutive)`;
      const dedup = checkModeChangeDedup(state, 'budget_warning', reason, nowMs);
      dedupDecisions.push(dedup);
      applyModeChange(state, 'DEGRADED', reason, nowMs);
      if (audit) await audit.modeTransition('NORMAL', 'DEGRADED', reason).catch(() => {});
      safeLog.warn('[AlarmPipeline] Auto-DEGRADE', {
        warnings: guardResult.warnings, notifySuppressed: !dedup.shouldNotify,
      });
      return { transitioned: true, reason };
    }
  }
  // Priority 3: CONTINUE — recover from DEGRADED
  else if (guardResult.verdict === 'CONTINUE' && state.extendedState.mode === 'DEGRADED') {
    state.hysteresis = {
      ...state.hysteresis,
      consecutiveContinueVerdicts: state.hysteresis.consecutiveContinueVerdicts + 1,
      consecutiveDegradeVerdicts: 0,
    };

    if (state.hysteresis.consecutiveContinueVerdicts >= RECOVER_HYSTERESIS_THRESHOLD) {
      const reason = `auto-recover: ${state.hysteresis.consecutiveContinueVerdicts} consecutive CONTINUE verdicts`;
      const dedup = checkModeChangeDedup(state, 'recovery_completed', reason, nowMs);
      dedupDecisions.push(dedup);
      applyModeChange(state, 'NORMAL', reason, nowMs);
      if (audit) await audit.modeTransition('DEGRADED', 'NORMAL', reason).catch(() => {});
      safeLog.info('[AlarmPipeline] Auto-RECOVER from DEGRADED');
      return { transitioned: true, reason };
    }
  }
  // Reset non-matching direction
  else if (guardResult.verdict === 'CONTINUE') {
    state.hysteresis = { ...state.hysteresis, consecutiveDegradeVerdicts: 0 };
  }

  return { transitioned: false };
}

// =============================================================================
// Guard processing (RECOVERY mode)
// =============================================================================

async function processRecoveryGuard(
  state: AlarmPipelineState,
  nowMs: number,
  dedupDecisions: DedupDecision[],
  audit?: AlarmPipelineAudit,
): Promise<{ transitioned: boolean; reason?: string }> {
  const guardInput = buildGuardInput(state);
  const guardResult = runGuardCheck(guardInput, nowMs);
  state.lastGuardCheck = guardResult;

  if (guardResult.verdict === 'CONTINUE') {
    state.hysteresis = {
      ...state.hysteresis,
      consecutiveContinueVerdicts: state.hysteresis.consecutiveContinueVerdicts + 1,
    };

    if (state.hysteresis.consecutiveContinueVerdicts >= RECOVER_HYSTERESIS_THRESHOLD) {
      const reason = `recovery-complete: health gate passed ${state.hysteresis.consecutiveContinueVerdicts} consecutive checks`;
      const dedup = checkModeChangeDedup(state, 'recovery_completed', reason, nowMs);
      dedupDecisions.push(dedup);
      applyModeChange(state, 'NORMAL', reason, nowMs);
      if (audit) await audit.modeTransition('RECOVERY', 'NORMAL', reason).catch(() => {});
      safeLog.info('[AlarmPipeline] Recovery completed, promoted to NORMAL');
      return { transitioned: true, reason };
    }
  } else {
    state.hysteresis = { ...state.hysteresis, consecutiveContinueVerdicts: 0 };
  }

  return { transitioned: false };
}

// =============================================================================
// State reconciliation (v1.3)
// =============================================================================

async function runReconciliation(
  state: AlarmPipelineState,
  storage: AlarmPipelineStorage,
  nowMs: number,
): Promise<boolean> {
  try {
    const [persistedExt, persistedHb, persistedCb, persistedBudget] = await Promise.all([
      storage.get<ExtendedRuntimeState>(STORAGE_KEY_STATE_V2),
      storage.get<HeartbeatState>(STORAGE_KEY_HEARTBEAT),
      storage.get<CircuitBreakerState>(STORAGE_KEY_CIRCUIT),
      storage.get<BudgetSnapshot>(STORAGE_KEY_BUDGET),
    ]);

    const input: ReconciliationInput = {
      inMemory: {
        extendedState: state.extendedState,
        heartbeat: state.heartbeatState,
        circuitBreaker: state.circuitBreakerState,
        budget: state.budgetSnapshot,
      },
      persisted: {
        extendedState: persistedExt,
        heartbeat: persistedHb,
        circuitBreaker: persistedCb,
        budget: persistedBudget,
      },
      nowMs,
    };

    const result = reconcileState(input);

    if (result.hasDrift) {
      state.extendedState = result.repairedState.extendedState;
      state.heartbeatState = result.repairedState.heartbeat;
      state.circuitBreakerState = result.repairedState.circuitBreaker;
      state.budgetSnapshot = result.repairedState.budget;

      safeLog.warn('[AlarmPipeline] State drift detected and repaired', {
        repairs: result.repairs,
        driftCount: result.drifts.filter((d) => d.resolution !== 'no_drift').length,
      });
      return true;
    }

    return false;
  } catch (err) {
    // Fail-closed: reconciliation errors don't affect alarm
    safeLog.error('[AlarmPipeline] Reconciliation error (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

// =============================================================================
// Provider probing (v1.3)
// =============================================================================

async function runProviderProbes(
  state: AlarmPipelineState,
  apiKeys: AlarmPipelineApiKeys,
): Promise<void> {
  const keyMap: Record<ProviderId, string | undefined> = {
    openai: apiKeys.OPENAI_API_KEY,
    glm: apiKeys.ZAI_API_KEY,
    gemini: apiKeys.GEMINI_API_KEY,
  };

  // Probe all providers in parallel
  const results = await Promise.allSettled(
    PROVIDER_IDS.map((id) => probeProvider(id, keyMap[id])),
  );

  for (const result of results) {
    if (result.status === 'fulfilled') {
      state.healthProbeState = recordProbeResult(state.healthProbeState, result.value);
    }
  }
}

// =============================================================================
// TTL cleanup (v1.3: idempotency keys + task results)
// =============================================================================

/**
 * Scan and delete expired idempotency entries and task results from DO storage.
 * Returns the number of entries cleaned up.
 */
async function runTtlCleanup(
  storage: AlarmPipelineStorage,
  nowMs: number,
): Promise<number> {
  let cleaned = 0;

  try {
    // Scan idempotency entries
    const idemEntries = await storage.list<IdempotencyEntry>(IDEMPOTENCY_PREFIX);
    if (idemEntries) {
      const expiredIdemKeys: string[] = [];
      for (const [key, entry] of idemEntries) {
        if (entry && entry.expiresAt <= nowMs) {
          expiredIdemKeys.push(key);
        }
      }
      if (expiredIdemKeys.length > 0) {
        await storage.deleteKeys(expiredIdemKeys);
        cleaned += expiredIdemKeys.length;
      }
    }

    // Scan task result entries
    const resultEntries = await storage.list<ExecutionResult>(EXEC_RESULT_PREFIX);
    if (resultEntries) {
      const expiredResultKeys: string[] = [];
      for (const [key, entry] of resultEntries) {
        if (entry && isResultExpired(entry, nowMs)) {
          expiredResultKeys.push(key);
        }
      }
      if (expiredResultKeys.length > 0) {
        await storage.deleteKeys(expiredResultKeys);
        cleaned += expiredResultKeys.length;
      }
    }

    if (cleaned > 0) {
      safeLog.info('[AlarmPipeline] TTL cleanup completed', {
        cleanedEntries: cleaned,
      });
    }
  } catch (err) {
    // Non-fatal: TTL cleanup failure doesn't affect alarm
    safeLog.error('[AlarmPipeline] TTL cleanup error (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return cleaned;
}

// =============================================================================
// Shared helpers
// =============================================================================

function buildGuardInput(state: AlarmPipelineState): GuardInput {
  return {
    budget: { spent: state.budgetSnapshot.spent, limit: state.budgetSnapshot.limit },
    circuitBreaker: { state: state.circuitBreakerState },
    heartbeat: { state: state.heartbeatState },
  };
}

/**
 * Check notification dedup before mode change.
 * Returns the dedup decision and updates dedupState in-place.
 */
function checkModeChangeDedup(
  state: AlarmPipelineState,
  notificationType: NotificationType,
  reason: string,
  nowMs: number,
): DedupDecision {
  const fingerprint = computeFingerprint(
    notificationType,
    state.extendedState.mode,
    { reason },
  );
  const { decision, nextState } = checkDedup(state.dedupState, fingerprint, nowMs);
  state.dedupState = nextState;
  return decision;
}

function applyModeChange(
  state: AlarmPipelineState,
  target: ExtendedMode,
  reason: string,
  nowMs: number,
): void {
  state.extendedState = applyExtendedTransition(state.extendedState, target, reason, nowMs);
  // Sync legacy state
  const legacyMode = toLegacyMode(target);
  if (legacyMode !== state.runtimeState.mode) {
    const result = transitionMode(state.runtimeState, legacyMode, reason, nowMs);
    state.runtimeState = applyTransition(state.runtimeState, result);
  }
  state.hysteresis = { consecutiveDegradeVerdicts: 0, consecutiveContinueVerdicts: 0 };
}
