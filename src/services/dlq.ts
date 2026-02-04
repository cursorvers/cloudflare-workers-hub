/**
 * Dead Letter Queue (DLQ) Service
 *
 * Manages failed receipt processing attempts that exceeded retry limits.
 * Failed items are stored in D1 for manual intervention and analysis.
 */

import type { Env } from '../types';
import { safeLog } from '../utils/log-sanitizer';

// =============================================================================
// Types
// =============================================================================

export type DLQSource = 'gmail' | 'web_scraper';
export type DLQStatus = 'pending' | 'retrying' | 'resolved' | 'abandoned';

export interface DLQEntry {
  id: string;
  source: DLQSource;
  originalMessage: unknown;
  failureReason: string;
  failureCount: number;
  firstFailedAt?: string;
  lastFailedAt?: string;
  status?: DLQStatus;
  resolutionNote?: string;
}

export interface DLQListResult {
  entries: DLQEntry[];
  total: number;
}

// =============================================================================
// DLQ Operations
// =============================================================================

/**
 * Send failed item to DLQ
 */
export async function sendToDLQ(env: Env, entry: DLQEntry): Promise<void> {
  if (!env.DB) {
    console.error('[DLQ] Database not configured');
    return;
  }

  try {
    // Insert or update DLQ entry
    await env.DB.prepare(
      `INSERT INTO receipt_processing_dlq
       (id, source, original_message, failure_reason, failure_count,
        first_failed_at, last_failed_at, status)
       VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'), 'pending')
       ON CONFLICT(id) DO UPDATE SET
         failure_count = failure_count + 1,
         last_failed_at = datetime('now'),
         failure_reason = ?,
         updated_at = datetime('now')`
    )
      .bind(
        entry.id,
        entry.source,
        JSON.stringify(entry.originalMessage),
        entry.failureReason,
        entry.failureCount,
        entry.failureReason
      )
      .run();

    safeLog(env, 'warn', 'Sent to DLQ', {
      id: entry.id,
      source: entry.source,
      failureCount: entry.failureCount,
    });

    // Alert if failure count exceeds threshold
    if (entry.failureCount >= 3) {
      await notifyDLQAlert(env, entry);
    }
  } catch (error) {
    console.error('[DLQ] Failed to send to DLQ:', error);
    // Don't throw - DLQ failures should not block main processing
  }
}

/**
 * Get DLQ entry by ID
 */
export async function getDLQEntry(env: Env, id: string): Promise<DLQEntry | null> {
  if (!env.DB) {
    throw new Error('Database not configured');
  }

  const result = await env.DB.prepare(
    `SELECT id, source, original_message, failure_reason, failure_count,
            first_failed_at, last_failed_at, status, resolution_note
     FROM receipt_processing_dlq
     WHERE id = ?`
  )
    .bind(id)
    .first();

  if (!result) {
    return null;
  }

  return {
    id: result.id as string,
    source: result.source as DLQSource,
    originalMessage: JSON.parse(result.original_message as string),
    failureReason: result.failure_reason as string,
    failureCount: result.failure_count as number,
    firstFailedAt: result.first_failed_at as string,
    lastFailedAt: result.last_failed_at as string,
    status: result.status as DLQStatus,
    resolutionNote: result.resolution_note as string | undefined,
  };
}

/**
 * List DLQ entries
 */
export async function listDLQEntries(
  env: Env,
  options: {
    status?: DLQStatus;
    source?: DLQSource;
    limit?: number;
    offset?: number;
  } = {}
): Promise<DLQListResult> {
  if (!env.DB) {
    throw new Error('Database not configured');
  }

  const { status, source, limit = 50, offset = 0 } = options;

  // Build WHERE clause
  const conditions: string[] = [];
  const bindings: string[] = [];

  if (status) {
    conditions.push('status = ?');
    bindings.push(status);
  }
  if (source) {
    conditions.push('source = ?');
    bindings.push(source);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  // Get total count
  const countResult = await env.DB.prepare(
    `SELECT COUNT(*) as total FROM receipt_processing_dlq ${whereClause}`
  )
    .bind(...bindings)
    .first();

  const total = (countResult?.total as number) || 0;

  // Get entries
  const entriesResult = await env.DB.prepare(
    `SELECT id, source, original_message, failure_reason, failure_count,
            first_failed_at, last_failed_at, status, resolution_note
     FROM receipt_processing_dlq
     ${whereClause}
     ORDER BY last_failed_at DESC
     LIMIT ? OFFSET ?`
  )
    .bind(...bindings, limit, offset)
    .all();

  const entries: DLQEntry[] = (entriesResult.results || []).map((row: any) => ({
    id: row.id,
    source: row.source,
    originalMessage: JSON.parse(row.original_message),
    failureReason: row.failure_reason,
    failureCount: row.failure_count,
    firstFailedAt: row.first_failed_at,
    lastFailedAt: row.last_failed_at,
    status: row.status,
    resolutionNote: row.resolution_note,
  }));

  return { entries, total };
}

/**
 * Update DLQ entry status
 */
export async function updateDLQStatus(
  env: Env,
  id: string,
  status: DLQStatus,
  resolutionNote?: string
): Promise<void> {
  if (!env.DB) {
    throw new Error('Database not configured');
  }

  await env.DB.prepare(
    `UPDATE receipt_processing_dlq
     SET status = ?, resolution_note = ?, updated_at = datetime('now')
     WHERE id = ?`
  )
    .bind(status, resolutionNote || null, id)
    .run();

  safeLog(env, 'info', 'DLQ status updated', { id, status });
}

/**
 * Delete DLQ entry
 */
export async function deleteDLQEntry(env: Env, id: string): Promise<void> {
  if (!env.DB) {
    throw new Error('Database not configured');
  }

  await env.DB.prepare('DELETE FROM receipt_processing_dlq WHERE id = ?')
    .bind(id)
    .run();

  safeLog(env, 'info', 'DLQ entry deleted', { id });
}

/**
 * Send DLQ alert notification
 */
async function notifyDLQAlert(env: Env, entry: DLQEntry): Promise<void> {
  if (!env.DISCORD_WEBHOOK_URL) {
    return;
  }

  const level = entry.failureCount >= 5 ? 'CRITICAL' : 'HIGH';
  const color = level === 'CRITICAL' ? 0xff0000 : 0xff9900;

  try {
    await fetch(env.DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embeds: [
          {
            title: `[${level}] DLQ Alert: ${entry.source}`,
            description: `Failed ${entry.failureCount} times: ${entry.failureReason}`,
            color,
            fields: [
              { name: 'ID', value: entry.id, inline: true },
              { name: 'Source', value: entry.source, inline: true },
              { name: 'Failure Count', value: entry.failureCount.toString(), inline: true },
            ],
            timestamp: new Date().toISOString(),
            footer: { text: 'freee Receipt System - DLQ' },
          },
        ],
      }),
    });
  } catch (error) {
    console.error('[DLQ] Failed to send Discord alert:', error);
  }
}
