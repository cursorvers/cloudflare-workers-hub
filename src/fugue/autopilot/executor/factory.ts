/**
 * Executor Factory — Builds ExecutorWorker from runtime environment.
 *
 * Bridges DO storage + Env bindings → fully configured ExecutorWorker.
 * Per-specialist CB states and weekly counts are loaded from DO storage.
 * API keys are injected from Env, never from process.env.
 */

import type { CircuitBreakerState } from '../runtime/circuit-breaker';
import { createCircuitBreakerState } from '../runtime/circuit-breaker';
import type { ExtendedMode } from '../runtime/coordinator';
import type { SpecialistRegistry } from '../specialist/types';
import { createRegistry, DEFAULT_SPECIALISTS } from '../specialist/registry';

import { ExecutorWorker, type CircuitUpdateCallback } from './executor-worker';
import { HttpProviderAdapter, type SpecialistEndpointConfig, DEFAULT_ENDPOINTS } from './provider-adapter';
import { LoggingSideEffectHandler } from './side-effects';
import type { ToolResult } from './types';

// =============================================================================
// Storage Keys
// =============================================================================

/** Per-specialist CB storage key: autopilot:cb:v2:{specialistId} */
export function cbStorageKey(specialistId: string): string {
  return `autopilot:cb:v2:${specialistId}`;
}

/** Per-specialist weekly count storage key: autopilot:weekly:v1:{specialistId}:{isoWeek} */
export function weeklyStorageKey(specialistId: string, isoWeek: string): string {
  return `autopilot:weekly:v1:${specialistId}:${isoWeek}`;
}

/** Get current ISO week string: YYYY-Www */
export function currentIsoWeek(nowMs?: number): string {
  const d = new Date(nowMs ?? Date.now());
  // ISO week date calculation
  const jan4 = new Date(d.getFullYear(), 0, 4);
  const dayOfYear = Math.floor((d.getTime() - jan4.getTime()) / 86_400_000) + 4;
  const weekNumber = Math.ceil(dayOfYear / 7);
  return `${d.getFullYear()}-W${String(weekNumber).padStart(2, '0')}`;
}

// =============================================================================
// Storage Interface (abstraction for DO storage)
// =============================================================================

export interface ExecutorStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(entries: Record<string, unknown>): Promise<void>;
}

// =============================================================================
// Env Keys
// =============================================================================

export interface ExecutorEnvKeys {
  readonly OPENAI_API_KEY?: string;
  readonly ZAI_API_KEY?: string;
  readonly GEMINI_API_KEY?: string;
}

// =============================================================================
// Factory Config
// =============================================================================

export interface ExecutorFactoryConfig {
  readonly env: ExecutorEnvKeys;
  readonly storage: ExecutorStorage;
  readonly mode: ExtendedMode;
  readonly registry?: SpecialistRegistry;
  readonly endpoints?: Readonly<Record<string, SpecialistEndpointConfig>>;
}

// =============================================================================
// Factory Result
// =============================================================================

export interface ExecutorFactoryResult {
  readonly worker: ExecutorWorker;
  readonly specialistIds: readonly string[];
}

// =============================================================================
// Load Helpers
// =============================================================================

async function loadCircuitStates(
  storage: ExecutorStorage,
  specialistIds: readonly string[],
): Promise<Map<string, CircuitBreakerState>> {
  const states = new Map<string, CircuitBreakerState>();
  const entries = await Promise.all(
    specialistIds.map(async (id) => {
      const stored = await storage.get<CircuitBreakerState>(cbStorageKey(id));
      return [id, stored ?? createCircuitBreakerState()] as const;
    }),
  );
  for (const [id, state] of entries) {
    states.set(id, Object.freeze({ ...state }));
  }
  return states;
}

async function loadWeeklyCounts(
  storage: ExecutorStorage,
  specialistIds: readonly string[],
  isoWeek: string,
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const entries = await Promise.all(
    specialistIds.map(async (id) => {
      const stored = await storage.get<number>(weeklyStorageKey(id, isoWeek));
      return [id, stored ?? 0] as const;
    }),
  );
  for (const [id, count] of entries) {
    counts.set(id, count);
  }
  return counts;
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create a fully configured ExecutorWorker from runtime environment.
 *
 * Loads per-specialist CB states and weekly counts from DO storage.
 * Injects API keys from Env into HttpProviderAdapter.
 * Returns the worker and a persist callback for post-execution updates.
 */
export async function createExecutorWorker(
  config: ExecutorFactoryConfig,
): Promise<ExecutorFactoryResult> {
  const registry = config.registry ?? createRegistry();
  const specialistIds = registry.specialists
    .filter((s) => s.enabled)
    .map((s) => s.id);

  const isoWeek = currentIsoWeek();

  // Load persisted state
  const [circuitStates, weeklyCount] = await Promise.all([
    loadCircuitStates(config.storage, specialistIds),
    loadWeeklyCounts(config.storage, specialistIds, isoWeek),
  ]);

  // Build API key env map for HttpProviderAdapter
  const envMap: Record<string, string | undefined> = {
    OPENAI_API_KEY: config.env.OPENAI_API_KEY,
    ZAI_API_KEY: config.env.ZAI_API_KEY,
    GEMINI_API_KEY: config.env.GEMINI_API_KEY,
  };

  const adapter = new HttpProviderAdapter({
    endpoints: config.endpoints ?? DEFAULT_ENDPOINTS,
    env: envMap,
  });

  // CB update callback: persist to DO storage
  const onCircuitUpdate: CircuitUpdateCallback = (specialistId, newState) => {
    // Fire-and-forget persistence — errors are swallowed by ExecutorWorker
    void config.storage.put({ [cbStorageKey(specialistId)]: newState });
  };

  const worker = new ExecutorWorker({
    adapter,
    registry,
    mode: config.mode,
    circuitStates,
    weeklyCount,
    sideEffects: new LoggingSideEffectHandler(),
    onCircuitUpdate,
  });

  return Object.freeze({
    worker,
    specialistIds: Object.freeze([...specialistIds]),
  });
}

/**
 * Increment weekly count for a specialist after successful execution.
 * Call this after ExecutorWorker.execute() returns a success result.
 */
export async function incrementWeeklyCount(
  storage: ExecutorStorage,
  specialistId: string,
  isoWeek?: string,
): Promise<void> {
  const week = isoWeek ?? currentIsoWeek();
  const key = weeklyStorageKey(specialistId, week);
  const current = (await storage.get<number>(key)) ?? 0;
  await storage.put({ [key]: current + 1 });
}
