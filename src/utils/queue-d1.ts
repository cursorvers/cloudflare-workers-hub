import type { Env } from '../types';

export type QueueTaskStatus = string;

export type QueueTaskRow = {
  task_id: string;
  task_json: string;
  status: QueueTaskStatus;
  priority: string;
  worker_id: string | null;
  lease_expires_at_ms: number | null;
  queued_at_ms: number;
  updated_at_ms: number;
};

export async function enqueueTaskD1(
  env: Env,
  taskId: string,
  task: Record<string, unknown>,
): Promise<void> {
  if (!env.DB) throw new Error('DB not available');

  const now = Date.now();
  const priority = typeof task.priority === 'string' ? task.priority : 'medium';

  await env.DB.prepare(
    `INSERT INTO queue_tasks (task_id, task_json, status, priority, worker_id, lease_expires_at_ms, queued_at_ms, updated_at_ms)
     VALUES (?, ?, 'pending', ?, NULL, NULL, ?, ?)
     ON CONFLICT(task_id) DO UPDATE SET
       task_json=excluded.task_json,
       status='pending',
       priority=excluded.priority,
       worker_id=NULL,
       lease_expires_at_ms=NULL,
       updated_at_ms=excluded.updated_at_ms`
  ).bind(taskId, JSON.stringify(task), priority, now, now).run();
}

export async function getTaskD1(env: Env, taskId: string): Promise<{ row: QueueTaskRow; task: Record<string, unknown> } | null> {
  if (!env.DB) throw new Error('DB not available');
  const row = await env.DB.prepare(
    `SELECT task_id, task_json, status, priority, worker_id, lease_expires_at_ms, queued_at_ms, updated_at_ms
     FROM queue_tasks
     WHERE task_id = ?
     LIMIT 1`
  ).bind(taskId).first() as QueueTaskRow | null;
  if (!row) return null;
  const task = JSON.parse(row.task_json) as Record<string, unknown>;
  return { row, task };
}

export async function listPendingTaskIdsD1(env: Env, limit = 200): Promise<string[]> {
  if (!env.DB) throw new Error('DB not available');
  const now = Date.now();
  const res = await env.DB.prepare(
    `SELECT task_id
     FROM queue_tasks
     WHERE status = 'pending'
        OR (status = 'claimed' AND lease_expires_at_ms IS NOT NULL AND lease_expires_at_ms < ?)
     ORDER BY
       CASE priority
         WHEN 'critical' THEN 4
         WHEN 'high' THEN 3
         WHEN 'medium' THEN 2
         WHEN 'low' THEN 1
         ELSE 2
       END DESC,
       queued_at_ms ASC
     LIMIT ?`
  ).bind(now, limit).all() as { results: Array<{ task_id: string }> };
  return (res.results || []).map((r) => r.task_id);
}

export async function claimNextTaskD1(
  env: Env,
  workerId: string,
  leaseDurationSec: number,
): Promise<{ taskId: string; task: Record<string, unknown>; lease: { workerId: string; claimedAt: string; expiresAt: string } } | null> {
  if (!env.DB) throw new Error('DB not available');
  const now = Date.now();
  const leaseExpiresAtMs = now + leaseDurationSec * 1000;

  // Select a small batch of candidates, then try to atomically claim each.
  const candidates = await env.DB.prepare(
    `SELECT task_id, task_json, status, priority, worker_id, lease_expires_at_ms, queued_at_ms, updated_at_ms
     FROM queue_tasks
     WHERE status = 'pending'
        OR (status = 'claimed' AND lease_expires_at_ms IS NOT NULL AND lease_expires_at_ms < ?)
     ORDER BY
       CASE priority
         WHEN 'critical' THEN 4
         WHEN 'high' THEN 3
         WHEN 'medium' THEN 2
         WHEN 'low' THEN 1
         ELSE 2
       END DESC,
       queued_at_ms ASC
     LIMIT 25`
  ).bind(now).all() as { results: QueueTaskRow[] };

  for (const row of candidates.results || []) {
    const result = await env.DB.prepare(
      `UPDATE queue_tasks
       SET status = 'claimed',
           worker_id = ?,
           lease_expires_at_ms = ?,
           updated_at_ms = ?
       WHERE task_id = ?
         AND (
           status = 'pending'
           OR (status = 'claimed' AND lease_expires_at_ms IS NOT NULL AND lease_expires_at_ms < ?)
         )`
    ).bind(workerId, leaseExpiresAtMs, now, row.task_id, now).run();

    if ((result as any)?.meta?.changes !== 1) continue;

    const task = JSON.parse(row.task_json) as Record<string, unknown>;
    const lease = {
      workerId,
      claimedAt: new Date(now).toISOString(),
      expiresAt: new Date(leaseExpiresAtMs).toISOString(),
    };

    // Overlay current status fields for compatibility with KV task shape.
    task.status = 'claimed';
    task.updatedAt = new Date(now).toISOString();

    return { taskId: row.task_id, task, lease };
  }

  return null;
}

export async function releaseTaskD1(env: Env, taskId: string, workerId?: string): Promise<{ success: boolean; error?: string }> {
  if (!env.DB) throw new Error('DB not available');
  const now = Date.now();

  if (workerId) {
    const existing = await env.DB.prepare(
      `SELECT worker_id FROM queue_tasks WHERE task_id = ? LIMIT 1`
    ).bind(taskId).first() as { worker_id?: string | null } | null;

    if (!existing) return { success: true, error: 'No active lease' };
    if (existing.worker_id && existing.worker_id !== workerId) return { success: false, error: 'Not lease holder' };
  }

  await env.DB.prepare(
    `UPDATE queue_tasks
     SET status='pending',
         worker_id=NULL,
         lease_expires_at_ms=NULL,
         updated_at_ms=?
     WHERE task_id=?`
  ).bind(now, taskId).run();

  return { success: true };
}

export async function renewTaskD1(env: Env, taskId: string, workerId: string, extendSec: number): Promise<{ success: boolean; error?: string; lease?: { workerId: string; expiresAt: string; renewedAt: string } }> {
  if (!env.DB) throw new Error('DB not available');
  const now = Date.now();
  const leaseExpiresAtMs = now + extendSec * 1000;

  const existing = await env.DB.prepare(
    `SELECT worker_id FROM queue_tasks WHERE task_id = ? LIMIT 1`
  ).bind(taskId).first() as { worker_id?: string | null } | null;

  if (!existing || !existing.worker_id || existing.worker_id !== workerId) {
    return { success: false, error: 'Invalid lease or not holder' };
  }

  await env.DB.prepare(
    `UPDATE queue_tasks
     SET lease_expires_at_ms=?,
         updated_at_ms=?
     WHERE task_id=? AND worker_id=?`
  ).bind(leaseExpiresAtMs, now, taskId, workerId).run();

  return {
    success: true,
    lease: {
      workerId,
      expiresAt: new Date(leaseExpiresAtMs).toISOString(),
      renewedAt: new Date(now).toISOString(),
    },
  };
}

export async function updateTaskStatusD1(env: Env, taskId: string, status: string): Promise<boolean> {
  if (!env.DB) throw new Error('DB not available');
  const now = Date.now();
  const result = await env.DB.prepare(
    `UPDATE queue_tasks SET updated_at_ms=?, status=? WHERE task_id=?`
  ).bind(now, status, taskId).run();
  return (result as any)?.meta?.changes === 1;
}

export async function storeResultD1(env: Env, taskId: string, result: Record<string, unknown>): Promise<void> {
  if (!env.DB) throw new Error('DB not available');
  const now = Date.now();

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO queue_results (task_id, result_json, created_at_ms)
       VALUES (?, ?, ?)
       ON CONFLICT(task_id) DO UPDATE SET
         result_json=excluded.result_json,
         created_at_ms=excluded.created_at_ms`
    ).bind(taskId, JSON.stringify(result), now),
    env.DB.prepare(`DELETE FROM queue_tasks WHERE task_id = ?`).bind(taskId),
  ]);
}

export async function getResultD1(env: Env, taskId: string): Promise<Record<string, unknown> | null> {
  if (!env.DB) throw new Error('DB not available');
  const row = await env.DB.prepare(
    `SELECT result_json FROM queue_results WHERE task_id = ? LIMIT 1`
  ).bind(taskId).first() as { result_json?: string } | null;
  if (!row?.result_json) return null;
  return JSON.parse(row.result_json) as Record<string, unknown>;
}
