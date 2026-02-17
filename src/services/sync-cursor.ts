/**
 * Sync Cursor Service
 *
 * Manages persistent cursor state in Supabase `sync_cursor` table.
 * Implements optimistic locking via `updated_at` comparison.
 *
 * Design decisions (from Issue #41 Tutti 6-agent consensus):
 * - Optimistic lock (not Advisory Lock) because Supabase REST API doesn't support pg_advisory_lock
 * - Fallback to 24h window when cursor is missing, stale (>7d), or in the future
 * - Advance cursor to `now()` even when 0 records fetched (prevents window expansion)
 * - Existing `limitless_id` upsert guarantees idempotent data inserts on retry
 */

import { safeLog } from '../utils/log-sanitizer';
import { supabaseSelect, supabaseUpdate, supabaseUpsert, SupabaseConfig } from './supabase-client';

// ============================================================================
// Types
// ============================================================================

export interface SyncCursorRow {
  source: string;
  cursor_value: string;
  updated_at: string;
  sync_count: number;
  last_error: string | null;
}

export interface CursorResult {
  startTime: Date;
  updatedAt: string;
  usedFallback: boolean;
  reason?: string;
}

// ============================================================================
// Constants
// ============================================================================

const MAX_CURSOR_AGE_DAYS = 7;
const FALLBACK_HOURS = 24;

// ============================================================================
// Public API
// ============================================================================

/**
 * Read the current sync cursor for a given source.
 * Returns a validated startTime with fallback handling for:
 * - Missing cursor → 24h fallback
 * - Future cursor → 24h fallback
 * - Stale cursor (>7d) → clamped to 7d
 */
export async function getCursor(
  config: SupabaseConfig,
  source: string
): Promise<CursorResult> {
  const fallback = (): CursorResult => ({
    startTime: new Date(Date.now() - FALLBACK_HOURS * 60 * 60 * 1000),
    updatedAt: '',
    usedFallback: true,
    reason: 'cursor_not_found',
  });

  try {
    const result = await supabaseSelect<SyncCursorRow>(
      config,
      'sync_cursor',
      `source=eq.${source}&limit=1`
    );

    if (result.error || !result.data || result.data.length === 0) {
      safeLog.warn('[SyncCursor] Cursor not found, using 24h fallback', { source });
      return fallback();
    }

    const row = result.data[0];
    const cursorDate = new Date(row.cursor_value);
    const now = Date.now();

    // Future cursor detection
    if (cursorDate.getTime() > now + 60_000) {
      safeLog.warn('[SyncCursor] Future cursor detected, using 24h fallback', {
        source,
        cursorValue: row.cursor_value,
      });
      return {
        startTime: new Date(now - FALLBACK_HOURS * 60 * 60 * 1000),
        updatedAt: row.updated_at,
        usedFallback: true,
        reason: 'future_cursor',
      };
    }

    // Stale cursor detection (>7 days)
    const ageMs = now - cursorDate.getTime();
    const maxAgeMs = MAX_CURSOR_AGE_DAYS * 24 * 60 * 60 * 1000;
    if (ageMs > maxAgeMs) {
      safeLog.warn('[SyncCursor] Cursor too old, clamping to max age', {
        source,
        cursorValue: row.cursor_value,
        ageDays: Math.round(ageMs / (24 * 60 * 60 * 1000)),
      });
      return {
        startTime: new Date(now - maxAgeMs),
        updatedAt: row.updated_at,
        usedFallback: true,
        reason: 'stale_cursor',
      };
    }

    return {
      startTime: cursorDate,
      updatedAt: row.updated_at,
      usedFallback: false,
    };
  } catch (error) {
    safeLog.error('[SyncCursor] Failed to read cursor', {
      source,
      error: error instanceof Error ? error.message : String(error),
    });
    return fallback();
  }
}

/**
 * Update the sync cursor after a successful sync.
 * Uses optimistic locking: only updates if `updated_at` matches the value read earlier.
 * Returns true if the update succeeded (no concurrent modification).
 */
export async function updateCursor(
  config: SupabaseConfig,
  source: string,
  newCursorValue: Date,
  previousUpdatedAt: string,
  syncedCount: number,
  lastError: string | null
): Promise<boolean> {
  const now = new Date().toISOString();

  // If we don't have a previous updated_at (first run / fallback), use upsert
  if (!previousUpdatedAt) {
    const result = await supabaseUpsert(
      config,
      'sync_cursor',
      {
        source,
        cursor_value: newCursorValue.toISOString(),
        updated_at: now,
        sync_count: syncedCount,
        last_error: lastError,
      },
      'source'
    );
    if (result.error) {
      safeLog.error('[SyncCursor] Upsert failed', {
        source,
        error: result.error.message,
      });
      return false;
    }
    return true;
  }

  // Optimistic lock: only update if updated_at matches
  const result = await supabaseUpdate(
    config,
    'sync_cursor',
    {
      cursor_value: newCursorValue.toISOString(),
      updated_at: now,
      sync_count: syncedCount,
      last_error: lastError,
    },
    `source=eq.${source}&updated_at=eq.${previousUpdatedAt}`
  );

  if (result.error) {
    safeLog.error('[SyncCursor] Optimistic lock update failed', {
      source,
      error: result.error.message,
    });
    return false;
  }

  // PostgREST returns empty array if WHERE didn't match (concurrent modification)
  const data = result.data as unknown[];
  if (!data || (Array.isArray(data) && data.length === 0)) {
    safeLog.warn('[SyncCursor] Optimistic lock conflict — another worker updated the cursor', {
      source,
      previousUpdatedAt,
    });
    return false;
  }

  safeLog.info('[SyncCursor] Cursor updated', {
    source,
    newCursorValue: newCursorValue.toISOString(),
    syncedCount,
  });
  return true;
}
