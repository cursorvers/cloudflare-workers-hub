/**
 * Autopilot Audit Log (D1 Write-Behind)
 *
 * WORM-guaranteed audit trail for runtime mode transitions,
 * guard checks, recovery attempts, and budget updates.
 * Uses D1 prepared statements with batch transactions.
 */

import type { Env } from '../../../types';
import { safeLog } from '../../../utils/log-sanitizer';

// =============================================================================
// Types
// =============================================================================

export const AUTOPILOT_AUDIT_EVENT_TYPES = [
  'mode_transition',
  'guard_check',
  'recovery_attempt',
  'recovery_approved',
  'recovery_denied',
  'budget_update',
  'circuit_breaker_change',
  'heartbeat_stale',
  'auto_stop',
  'alarm_error',
  'task_dlq',
] as const;

export type AutopilotAuditEventType = typeof AUTOPILOT_AUDIT_EVENT_TYPES[number];

export interface AutopilotAuditEntry {
  readonly eventType: AutopilotAuditEventType;
  readonly previousMode?: string;
  readonly newMode?: string;
  readonly reason?: string;
  readonly actor?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface AutopilotAuditRow {
  readonly id: number;
  readonly event_type: string;
  readonly previous_mode: string | null;
  readonly new_mode: string | null;
  readonly reason: string | null;
  readonly actor: string | null;
  readonly metadata: string | null;
  readonly created_at: string;
}

export interface AuditQueryOptions {
  readonly eventType?: AutopilotAuditEventType;
  readonly limit?: number;
  readonly offset?: number;
  readonly since?: string;
}

// =============================================================================
// Write Operations
// =============================================================================

/**
 * Write a single audit entry to D1.
 * Fails silently with log if DB is unavailable (non-blocking).
 */
export async function writeAuditEntry(
  env: Env,
  entry: AutopilotAuditEntry,
): Promise<boolean> {
  if (!env.DB) {
    safeLog.warn('[AutopilotAudit] DB not available, audit entry dropped', {
      eventType: entry.eventType,
    });
    return false;
  }

  try {
    await env.DB.prepare(
      `INSERT INTO autopilot_audit_logs
       (event_type, previous_mode, new_mode, reason, actor, metadata)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(
      entry.eventType,
      entry.previousMode ?? null,
      entry.newMode ?? null,
      entry.reason ?? null,
      entry.actor ?? null,
      entry.metadata ? JSON.stringify(entry.metadata) : null,
    ).run();

    return true;
  } catch (err) {
    safeLog.error('[AutopilotAudit] Failed to write audit entry', {
      eventType: entry.eventType,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Write multiple audit entries atomically using D1 batch.
 */
export async function writeAuditBatch(
  env: Env,
  entries: readonly AutopilotAuditEntry[],
): Promise<boolean> {
  if (!env.DB) {
    safeLog.warn('[AutopilotAudit] DB not available, batch dropped', {
      count: entries.length,
    });
    return false;
  }

  if (entries.length === 0) return true;

  try {
    const statements = entries.map((entry) =>
      env.DB!.prepare(
        `INSERT INTO autopilot_audit_logs
         (event_type, previous_mode, new_mode, reason, actor, metadata)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(
        entry.eventType,
        entry.previousMode ?? null,
        entry.newMode ?? null,
        entry.reason ?? null,
        entry.actor ?? null,
        entry.metadata ? JSON.stringify(entry.metadata) : null,
      ),
    );

    await env.DB.batch(statements);
    return true;
  } catch (err) {
    safeLog.error('[AutopilotAudit] Batch write failed', {
      count: entries.length,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

// =============================================================================
// Read Operations
// =============================================================================

/**
 * Query audit logs with optional filters.
 */
export async function queryAuditLogs(
  env: Env,
  options: AuditQueryOptions = {},
): Promise<readonly AutopilotAuditRow[]> {
  if (!env.DB) {
    safeLog.warn('[AutopilotAudit] DB not available for query');
    return Object.freeze([]);
  }

  const limit = Math.min(options.limit ?? 50, 200);
  const offset = options.offset ?? 0;

  try {
    let sql = 'SELECT id, event_type, previous_mode, new_mode, reason, actor, metadata, created_at FROM autopilot_audit_logs';
    const params: (string | number)[] = [];
    const conditions: string[] = [];

    if (options.eventType) {
      conditions.push('event_type = ?');
      params.push(options.eventType);
    }

    if (options.since) {
      conditions.push('created_at >= ?');
      params.push(options.since);
    }

    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }

    sql += ' ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const result = await env.DB.prepare(sql).bind(...params).all() as {
      results: AutopilotAuditRow[];
    };

    return Object.freeze(result.results ?? []);
  } catch (err) {
    safeLog.error('[AutopilotAudit] Query failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return Object.freeze([]);
  }
}

/**
 * Count audit entries by event type.
 */
export async function countAuditEntries(
  env: Env,
  eventType?: AutopilotAuditEventType,
): Promise<number> {
  if (!env.DB) return 0;

  try {
    let sql = 'SELECT COUNT(*) as count FROM autopilot_audit_logs';
    const params: string[] = [];

    if (eventType) {
      sql += ' WHERE event_type = ?';
      params.push(eventType);
    }

    const row = await env.DB.prepare(sql).bind(...params).first() as { count: number } | null;
    return row?.count ?? 0;
  } catch (err) {
    safeLog.error('[AutopilotAudit] Count failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}

// =============================================================================
// Convenience Helpers
// =============================================================================

export function auditModeTransition(
  env: Env,
  previousMode: string,
  newMode: string,
  reason: string,
  actor?: string,
): Promise<boolean> {
  return writeAuditEntry(env, {
    eventType: 'mode_transition',
    previousMode,
    newMode,
    reason,
    actor,
  });
}

export function auditGuardCheck(
  env: Env,
  verdict: string,
  reasons: readonly string[],
  warnings: readonly string[],
): Promise<boolean> {
  return writeAuditEntry(env, {
    eventType: 'guard_check',
    metadata: { verdict, reasons, warnings },
  });
}

export function auditAutoStop(
  env: Env,
  previousMode: string,
  reasons: readonly string[],
): Promise<boolean> {
  return writeAuditEntry(env, {
    eventType: 'auto_stop',
    previousMode,
    newMode: 'STOPPED',
    reason: reasons.join('; '),
    metadata: { reasons },
  });
}

export function auditRecovery(
  env: Env,
  approved: boolean,
  approvedBy: string,
  reason: string,
): Promise<boolean> {
  return writeAuditEntry(env, {
    eventType: approved ? 'recovery_approved' : 'recovery_denied',
    previousMode: 'STOPPED',
    newMode: approved ? 'NORMAL' : 'STOPPED',
    reason,
    actor: approvedBy,
  });
}

export function auditBudgetUpdate(
  env: Env,
  spent: number,
  limit: number,
): Promise<boolean> {
  return writeAuditEntry(env, {
    eventType: 'budget_update',
    metadata: { spent, limit, ratio: spent / limit },
  });
}

export function auditTaskDLQ(
  env: Env,
  taskId: string,
  taskType: string,
  error: string,
): Promise<boolean> {
  return writeAuditEntry(env, {
    eventType: 'task_dlq',
    reason: error,
    metadata: { taskId, taskType },
  });
}
