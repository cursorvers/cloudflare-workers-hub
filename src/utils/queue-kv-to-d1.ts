import type { Env } from '../types';
import { safeLog } from './log-sanitizer';
import { TASK_INDEX_KEY } from './task-index';

function parseIsoMs(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

function getString(v: unknown): string | null {
  return typeof v === 'string' && v.length ? v : null;
}

async function upsertQueueTaskFromKV(env: Env, taskId: string, task: Record<string, unknown>, lease: Record<string, unknown> | null): Promise<void> {
  if (!env.DB) throw new Error('DB not available');

  const now = Date.now();
  const priority = typeof task.priority === 'string' ? task.priority : 'medium';

  // Determine lease status
  const leaseWorkerId = lease ? getString(lease.workerId) : null;
  const leaseExpiresAtMs = lease ? (parseIsoMs(lease.expiresAt) ?? null) : null;
  const leaseActive = !!(leaseWorkerId && leaseExpiresAtMs && leaseExpiresAtMs > now);

  const status = leaseActive ? 'claimed' : 'pending';
  const queuedAtMs = parseIsoMs(task.queuedAt) ?? now;

  // Overlay for compatibility with old KV task JSON.
  task.status = status;
  task.updatedAt = new Date(now).toISOString();

  await env.DB.prepare(
    `INSERT INTO queue_tasks (task_id, task_json, status, priority, worker_id, lease_expires_at_ms, queued_at_ms, updated_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(task_id) DO UPDATE SET
       task_json=excluded.task_json,
       status=excluded.status,
       priority=excluded.priority,
       worker_id=excluded.worker_id,
       lease_expires_at_ms=excluded.lease_expires_at_ms,
       queued_at_ms=excluded.queued_at_ms,
       updated_at_ms=excluded.updated_at_ms`
  ).bind(
    taskId,
    JSON.stringify(task),
    status,
    priority,
    leaseActive ? leaseWorkerId : null,
    leaseActive ? leaseExpiresAtMs : null,
    queuedAtMs,
    now
  ).run();
}

async function upsertQueueResultFromKV(env: Env, taskId: string, result: Record<string, unknown>): Promise<void> {
  if (!env.DB) throw new Error('DB not available');
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO queue_results (task_id, result_json, created_at_ms)
     VALUES (?, ?, ?)
     ON CONFLICT(task_id) DO UPDATE SET
       result_json=excluded.result_json,
       created_at_ms=excluded.created_at_ms`
  ).bind(taskId, JSON.stringify(result), now).run();
}

export async function migrateQueueTasksKVToD1(env: Env, opts: { cursor?: string; limit: number; cleanup: boolean }): Promise<{
  migrated: number;
  skipped: number;
  errors: string[];
  cursor?: string;
  list_complete: boolean;
}> {
  if (!env.CACHE) throw new Error('CACHE (KV) not available');
  if (!env.DB) throw new Error('DB (D1) not available');

  const kv = env.CACHE;
  const errors: string[] = [];
  let migrated = 0;
  let skipped = 0;

  // NOTE: KV list is quota-sensitive; keep this endpoint admin-only and use small limits.
  const listed = await kv.list({ prefix: 'queue:task:', cursor: opts.cursor, limit: opts.limit });
  const cursor = (listed as any).cursor as string | undefined;

  for (const k of listed.keys) {
    const name = k.name;
    const taskId = name.slice('queue:task:'.length);
    try {
      const task = await kv.get<Record<string, unknown>>(name, 'json');
      if (!task) {
        skipped++;
        continue;
      }

      const lease = await kv.get<Record<string, unknown>>(`queue:lease:${taskId}`, 'json');
      await upsertQueueTaskFromKV(env, taskId, task, lease);
      migrated++;

      if (opts.cleanup) {
        await kv.delete(name);
        await kv.delete(`queue:lease:${taskId}`);
      }
    } catch (e) {
      errors.push(`${taskId}: ${String(e)}`);
    }
  }

  if (opts.cleanup && migrated > 0) {
    try {
      await kv.delete(TASK_INDEX_KEY);
    } catch {
      // best effort
    }
  }

  safeLog.log('[Queue KV->D1] migrate tasks', {
    migrated,
    skipped,
    errors: errors.length,
    list_complete: listed.list_complete,
  });

  return {
    migrated,
    skipped,
    errors,
    cursor,
    list_complete: listed.list_complete,
  };
}

export async function migrateResultsKVToD1(env: Env, opts: { cursor?: string; limit: number; cleanup: boolean }): Promise<{
  migrated: number;
  skipped: number;
  errors: string[];
  cursor?: string;
  list_complete: boolean;
}> {
  if (!env.CACHE) throw new Error('CACHE (KV) not available');
  if (!env.DB) throw new Error('DB (D1) not available');

  const kv = env.CACHE;
  const errors: string[] = [];
  let migrated = 0;
  let skipped = 0;

  const listed = await kv.list({ prefix: 'orchestrator:result:', cursor: opts.cursor, limit: opts.limit });
  const cursor = (listed as any).cursor as string | undefined;
  for (const k of listed.keys) {
    const name = k.name;
    const taskId = name.slice('orchestrator:result:'.length);
    try {
      const result = await kv.get<Record<string, unknown>>(name, 'json');
      if (!result) {
        skipped++;
        continue;
      }
      await upsertQueueResultFromKV(env, taskId, result);
      migrated++;
      if (opts.cleanup) {
        await kv.delete(name);
      }
    } catch (e) {
      errors.push(`${taskId}: ${String(e)}`);
    }
  }

  safeLog.log('[Queue KV->D1] migrate results', {
    migrated,
    skipped,
    errors: errors.length,
    list_complete: listed.list_complete,
  });

  return {
    migrated,
    skipped,
    errors,
    cursor,
    list_complete: listed.list_complete,
  };
}
