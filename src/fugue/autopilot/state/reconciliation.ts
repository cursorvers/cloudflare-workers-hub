/**
 * State Reconciliation — Detects and repairs drift between
 * in-memory state and DO storage.
 *
 * Triggered on: DO initialization, mode transitions, periodic alarm checks.
 * Fail-closed: reconciliation errors preserve current state (never corrupt).
 *
 * Uses version counters for deterministic conflict resolution
 * (GLM CRITICAL: version-based resolution, not arbitrary overwrite).
 */

import type { ExtendedRuntimeState } from '../runtime/coordinator';
import type { HeartbeatState } from '../runtime/heartbeat';
import type { CircuitBreakerState } from '../runtime/circuit-breaker';
import type { BudgetSnapshot } from '../durable-objects/autopilot-coordinator';

// =============================================================================
// Types
// =============================================================================

export interface ReconciliationInput {
  readonly inMemory: {
    readonly extendedState: ExtendedRuntimeState;
    readonly heartbeat: HeartbeatState;
    readonly circuitBreaker: CircuitBreakerState;
    readonly budget: BudgetSnapshot;
  };
  readonly persisted: {
    readonly extendedState: ExtendedRuntimeState | undefined;
    readonly heartbeat: HeartbeatState | undefined;
    readonly circuitBreaker: CircuitBreakerState | undefined;
    readonly budget: BudgetSnapshot | undefined;
  };
  readonly nowMs: number;
}

export type DriftField = 'extendedState' | 'heartbeat' | 'circuitBreaker' | 'budget';

export interface DriftEntry {
  readonly field: DriftField;
  readonly inMemoryValue: unknown;
  readonly persistedValue: unknown;
  readonly resolution: 'keep_memory' | 'restore_persisted' | 'no_drift';
  readonly reason: string;
}

export interface ReconciliationResult {
  readonly hasDrift: boolean;
  readonly drifts: readonly DriftEntry[];
  readonly repairs: readonly DriftField[];
  readonly repairedState: {
    readonly extendedState: ExtendedRuntimeState;
    readonly heartbeat: HeartbeatState;
    readonly circuitBreaker: CircuitBreakerState;
    readonly budget: BudgetSnapshot;
  };
  readonly timestamp: number;
}

// =============================================================================
// Pure Reconciliation Logic
// =============================================================================

/**
 * Detect drift between in-memory and persisted state.
 * Resolution strategy:
 * - ExtendedState: prefer higher transitionCount (more recent)
 * - Heartbeat: prefer more recent lastHeartbeat
 * - CircuitBreaker: prefer in-memory (always live)
 * - Budget: prefer higher updatedAt timestamp
 */
export function reconcileState(input: ReconciliationInput): ReconciliationResult {
  const drifts: DriftEntry[] = [];
  const repairs: DriftField[] = [];

  // Extended state: prefer higher transitionCount (deterministic)
  const extDrift = reconcileExtendedState(
    input.inMemory.extendedState,
    input.persisted.extendedState,
  );
  drifts.push(extDrift);

  // Heartbeat: prefer more recent lastHeartbeat
  const hbDrift = reconcileHeartbeat(
    input.inMemory.heartbeat,
    input.persisted.heartbeat,
  );
  drifts.push(hbDrift);

  // Circuit breaker: in-memory is authoritative (live tracking)
  const cbDrift = reconcileCircuitBreaker(
    input.inMemory.circuitBreaker,
    input.persisted.circuitBreaker,
  );
  drifts.push(cbDrift);

  // Budget: prefer higher updatedAt
  const budgetDrift = reconcileBudget(
    input.inMemory.budget,
    input.persisted.budget,
  );
  drifts.push(budgetDrift);

  const activeDrifts = drifts.filter((d) => d.resolution !== 'no_drift');
  for (const drift of activeDrifts) {
    if (drift.resolution === 'restore_persisted') {
      repairs.push(drift.field);
    }
  }

  return Object.freeze({
    hasDrift: activeDrifts.length > 0,
    drifts: Object.freeze(drifts),
    repairs: Object.freeze(repairs),
    repairedState: Object.freeze({
      extendedState: extDrift.resolution === 'restore_persisted' && input.persisted.extendedState
        ? input.persisted.extendedState
        : input.inMemory.extendedState,
      heartbeat: hbDrift.resolution === 'restore_persisted' && input.persisted.heartbeat
        ? input.persisted.heartbeat
        : input.inMemory.heartbeat,
      circuitBreaker: input.inMemory.circuitBreaker, // Always in-memory
      budget: budgetDrift.resolution === 'restore_persisted' && input.persisted.budget
        ? input.persisted.budget
        : input.inMemory.budget,
    }),
    timestamp: input.nowMs,
  });
}

// =============================================================================
// Field-level reconciliation
// =============================================================================

function reconcileExtendedState(
  inMemory: ExtendedRuntimeState,
  persisted: ExtendedRuntimeState | undefined,
): DriftEntry {
  if (!persisted) {
    return Object.freeze({
      field: 'extendedState' as const,
      inMemoryValue: inMemory.mode,
      persistedValue: undefined,
      resolution: 'keep_memory' as const,
      reason: 'no persisted state available',
    });
  }

  if (inMemory.mode === persisted.mode && inMemory.transitionCount === persisted.transitionCount) {
    return Object.freeze({
      field: 'extendedState' as const,
      inMemoryValue: inMemory.mode,
      persistedValue: persisted.mode,
      resolution: 'no_drift' as const,
      reason: 'mode and transitionCount match',
    });
  }

  // Higher transitionCount = more recent state
  if (persisted.transitionCount > inMemory.transitionCount) {
    return Object.freeze({
      field: 'extendedState' as const,
      inMemoryValue: inMemory.mode,
      persistedValue: persisted.mode,
      resolution: 'restore_persisted' as const,
      reason: `persisted transitionCount (${persisted.transitionCount}) > in-memory (${inMemory.transitionCount})`,
    });
  }

  return Object.freeze({
    field: 'extendedState' as const,
    inMemoryValue: inMemory.mode,
    persistedValue: persisted.mode,
    resolution: 'keep_memory' as const,
    reason: `in-memory transitionCount (${inMemory.transitionCount}) >= persisted (${persisted.transitionCount})`,
  });
}

function reconcileHeartbeat(
  inMemory: HeartbeatState,
  persisted: HeartbeatState | undefined,
): DriftEntry {
  const inMem = inMemory.lastHeartbeatMs;
  const pers = persisted?.lastHeartbeatMs ?? null;

  if (!persisted) {
    return Object.freeze({
      field: 'heartbeat' as const,
      inMemoryValue: inMem,
      persistedValue: undefined,
      resolution: 'keep_memory' as const,
      reason: 'no persisted heartbeat',
    });
  }

  if (inMem === pers) {
    return Object.freeze({
      field: 'heartbeat' as const,
      inMemoryValue: inMem,
      persistedValue: pers,
      resolution: 'no_drift' as const,
      reason: 'lastHeartbeatMs matches',
    });
  }

  // If one side has never recorded a heartbeat, prefer the side that has one.
  if (inMem === null && pers !== null) {
    return Object.freeze({
      field: 'heartbeat' as const,
      inMemoryValue: inMem,
      persistedValue: pers,
      resolution: 'restore_persisted' as const,
      reason: 'in-memory heartbeat missing; restoring persisted',
    });
  }

  if (pers === null && inMem !== null) {
    return Object.freeze({
      field: 'heartbeat' as const,
      inMemoryValue: inMem,
      persistedValue: pers,
      resolution: 'keep_memory' as const,
      reason: 'persisted heartbeat missing; keeping in-memory',
    });
  }

  // Both non-null here.
  if ((pers as number) > (inMem as number)) {
    return Object.freeze({
      field: 'heartbeat' as const,
      inMemoryValue: inMem,
      persistedValue: pers,
      resolution: 'restore_persisted' as const,
      reason: 'persisted heartbeat is more recent',
    });
  }

  return Object.freeze({
    field: 'heartbeat' as const,
    inMemoryValue: inMem,
    persistedValue: pers,
    resolution: 'keep_memory' as const,
    reason: 'in-memory heartbeat is more recent',
  });
}
function reconcileCircuitBreaker(
  inMemory: CircuitBreakerState,
  _persisted: CircuitBreakerState | undefined,
): DriftEntry {
  // Circuit breaker in-memory is always authoritative (live failure tracking)
  return Object.freeze({
    field: 'circuitBreaker' as const,
    inMemoryValue: inMemory.state,
    persistedValue: _persisted?.state,
    resolution: 'no_drift' as const,
    reason: 'circuit breaker: in-memory always authoritative',
  });
}

function reconcileBudget(
  inMemory: BudgetSnapshot,
  persisted: BudgetSnapshot | undefined,
): DriftEntry {
  if (!persisted) {
    return Object.freeze({
      field: 'budget' as const,
      inMemoryValue: inMemory.updatedAt,
      persistedValue: undefined,
      resolution: 'keep_memory' as const,
      reason: 'no persisted budget',
    });
  }

  if (inMemory.spent === persisted.spent && inMemory.limit === persisted.limit) {
    return Object.freeze({
      field: 'budget' as const,
      inMemoryValue: inMemory.updatedAt,
      persistedValue: persisted.updatedAt,
      resolution: 'no_drift' as const,
      reason: 'budget matches',
    });
  }

  if (persisted.updatedAt > inMemory.updatedAt) {
    return Object.freeze({
      field: 'budget' as const,
      inMemoryValue: inMemory.updatedAt,
      persistedValue: persisted.updatedAt,
      resolution: 'restore_persisted' as const,
      reason: 'persisted budget is more recent',
    });
  }

  return Object.freeze({
    field: 'budget' as const,
    inMemoryValue: inMemory.updatedAt,
    persistedValue: persisted.updatedAt,
    resolution: 'keep_memory' as const,
    reason: 'in-memory budget is more recent',
  });
}
