/**
 * Notification Deduplication — Prevents alert storms during mode transitions.
 *
 * Uses fingerprint + TTL + mode-aware key for dedup.
 * State is persisted to DO storage (GLM MAJOR: survives DO eviction).
 *
 * Pure functions: all state is immutable and frozen.
 */

import type { NotificationType } from './notification-dispatcher';

// =============================================================================
// Constants
// =============================================================================

/** Default dedup window (5 minutes) */
export const DEFAULT_DEDUP_WINDOW_MS = 5 * 60 * 1000;

/** Maximum dedup entries before cleanup */
export const MAX_DEDUP_ENTRIES = 100;

/** Dedup storage key prefix */
export const DEDUP_STORAGE_PREFIX = 'autopilot:notify-dedup:';

// =============================================================================
// Types
// =============================================================================

export interface DedupEntry {
  readonly fingerprint: string;
  readonly firstSeen: number;
  readonly lastSeen: number;
  readonly count: number;
  readonly expiresAt: number;
}

export interface DedupState {
  readonly entries: ReadonlyMap<string, DedupEntry>;
}

export interface DedupDecision {
  readonly shouldNotify: boolean;
  readonly fingerprint: string;
  readonly reason: string;
  readonly suppressedCount: number;
}

// =============================================================================
// Pure Functions
// =============================================================================

export function createDedupState(): DedupState {
  return Object.freeze({
    entries: new Map<string, DedupEntry>(),
  });
}

/**
 * Generate a fingerprint for dedup. Mode-aware to allow re-notification
 * after mode transitions (e.g., DEGRADED→NORMAL→DEGRADED should notify again).
 */
export function computeFingerprint(
  type: NotificationType,
  mode: string,
  metadata?: Record<string, unknown>,
): string {
  const metaKey = metadata?.reason ? String(metadata.reason).slice(0, 64) : '';
  return `${type}:${mode}:${metaKey}`;
}

/**
 * Check if notification should be sent or suppressed.
 */
export function checkDedup(
  state: DedupState,
  fingerprint: string,
  nowMs: number,
  windowMs: number = DEFAULT_DEDUP_WINDOW_MS,
): { decision: DedupDecision; nextState: DedupState } {
  const existing = state.entries.get(fingerprint);

  // No existing entry → allow notification
  if (!existing) {
    const entry: DedupEntry = Object.freeze({
      fingerprint,
      firstSeen: nowMs,
      lastSeen: nowMs,
      count: 1,
      expiresAt: nowMs + windowMs,
    });

    const newEntries = new Map(state.entries);
    newEntries.set(fingerprint, entry);

    return {
      decision: Object.freeze({
        shouldNotify: true,
        fingerprint,
        reason: 'first occurrence',
        suppressedCount: 0,
      }),
      nextState: Object.freeze({ entries: newEntries }),
    };
  }

  // Existing but expired → allow notification (reset)
  if (existing.expiresAt <= nowMs) {
    const entry: DedupEntry = Object.freeze({
      fingerprint,
      firstSeen: nowMs,
      lastSeen: nowMs,
      count: 1,
      expiresAt: nowMs + windowMs,
    });

    const newEntries = new Map(state.entries);
    newEntries.set(fingerprint, entry);

    return {
      decision: Object.freeze({
        shouldNotify: true,
        fingerprint,
        reason: 'previous entry expired',
        suppressedCount: 0,
      }),
      nextState: Object.freeze({ entries: newEntries }),
    };
  }

  // Existing and within window → suppress
  const updatedEntry: DedupEntry = Object.freeze({
    ...existing,
    lastSeen: nowMs,
    count: existing.count + 1,
  });

  const newEntries = new Map(state.entries);
  newEntries.set(fingerprint, updatedEntry);

  return {
    decision: Object.freeze({
      shouldNotify: false,
      fingerprint,
      reason: `duplicate within ${windowMs}ms window (count: ${updatedEntry.count})`,
      suppressedCount: updatedEntry.count - 1,
    }),
    nextState: Object.freeze({ entries: newEntries }),
  };
}

/**
 * Cleanup expired entries to prevent unbounded growth.
 */
export function cleanupExpired(state: DedupState, nowMs: number): DedupState {
  const newEntries = new Map<string, DedupEntry>();

  for (const [key, entry] of state.entries) {
    if (entry.expiresAt > nowMs) {
      newEntries.set(key, entry);
    }
  }

  // Safety: cap at MAX_DEDUP_ENTRIES (evict oldest)
  if (newEntries.size > MAX_DEDUP_ENTRIES) {
    const sorted = [...newEntries.entries()].sort(
      ([, a], [, b]) => a.firstSeen - b.firstSeen,
    );
    const trimmed = sorted.slice(sorted.length - MAX_DEDUP_ENTRIES);
    return Object.freeze({ entries: new Map(trimmed) });
  }

  return Object.freeze({ entries: newEntries });
}

/**
 * Serialize dedup state for DO storage persistence.
 */
export function serializeDedupState(state: DedupState): Record<string, DedupEntry> {
  const result: Record<string, DedupEntry> = {};
  for (const [key, entry] of state.entries) {
    result[key] = entry;
  }
  return result;
}

/**
 * Deserialize dedup state from DO storage.
 */
export function deserializeDedupState(data: Record<string, DedupEntry> | undefined): DedupState {
  if (!data) return createDedupState();

  const entries = new Map<string, DedupEntry>();
  for (const [key, entry] of Object.entries(data)) {
    if (entry && typeof entry.fingerprint === 'string') {
      entries.set(key, Object.freeze(entry));
    }
  }

  return Object.freeze({ entries });
}
