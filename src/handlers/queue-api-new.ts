/**
 * New Queue API Handlers (KV Prefix Scan)
 *
 * Migrated from single pending list to individual task keys
 */

import { KVNamespace } from '@cloudflare/workers-types';
import { safeLog } from '../utils/log-sanitizer';

export interface LeaseData {
  workerId: string;
  claimedAt: string;
  expiresAt: string;
  renewedAt?: string;
}

export interface TaskData {
  id: string;
  type: 'task' | 'query' | 'approval' | 'notification';
  source: string;
  content: string;
  priority: 'low' | 'medium' | 'high' | 'critical';
  metadata: Record<string, unknown>;
  queuedAt: string;
  status: 'pending' | 'claimed' | 'completed' | 'failed';
}

/**
 * GET /api/queue - List all pending tasks using KV prefix scan
 */
export async function listPendingTasks(kv: KVNamespace): Promise<{
  pending: string[];
  count: number;
}> {
  const taskKeys = await kv.list({ prefix: 'queue:task:' });
  const pending: string[] = [];

  for (const key of taskKeys.keys) {
    // Extract taskId from key: queue:task:{taskId}
    const taskId = key.name.replace('queue:task:', '');
    pending.push(taskId);
  }

  safeLog.log('[Queue API] Listed tasks', { count: pending.length });

  return { pending, count: pending.length };
}

/**
 * POST /api/queue/claim - Atomically claim next available task
 */
export async function claimTask(
  kv: KVNamespace,
  workerId: string,
  leaseDuration: number
): Promise<{
  success: boolean;
  taskId?: string;
  task?: TaskData;
  lease?: LeaseData;
  message?: string;
  pending?: number;
}> {
  // Use KV prefix scan to find all tasks
  const taskKeys = await kv.list({ prefix: 'queue:task:' });

  // Find first task that isn't already leased
  for (const key of taskKeys.keys) {
    const taskId = key.name.replace('queue:task:', '');
    const leaseKey = `queue:lease:${taskId}`;
    const existingLease = await kv.get(leaseKey);

    if (existingLease) {
      // Task already leased by another worker
      continue;
    }

    // Try to acquire lease (atomic via KV put)
    const leaseData: LeaseData = {
      workerId,
      claimedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + leaseDuration * 1000).toISOString(),
    };

    await kv.put(leaseKey, JSON.stringify(leaseData), { expirationTtl: leaseDuration });

    // Verify we got the lease (in case of race condition)
    const verifyLease = await kv.get<LeaseData>(leaseKey, 'json');
    if (verifyLease?.workerId !== workerId) {
      // Lost race, try next task
      continue;
    }

    // Successfully claimed - fetch task details from new key format
    const task = await kv.get<TaskData>(`queue:task:${taskId}`, 'json');
    if (!task) {
      // Task was deleted, release lease and try next
      await kv.delete(leaseKey);
      continue;
    }

    safeLog.log('[Queue API] Task claimed', { taskId, workerId, leaseDuration });

    return {
      success: true,
      taskId,
      task,
      lease: leaseData,
    };
  }

  // No available tasks
  return {
    success: false,
    message: 'No tasks available or all tasks are leased',
    pending: 0,
  };
}

/**
 * POST /api/queue/:taskId/release - Release a lease
 */
export async function releaseLease(
  kv: KVNamespace,
  taskId: string,
  workerId?: string,
  reason?: string
): Promise<{
  success: boolean;
  message?: string;
  error?: string;
}> {
  const leaseKey = `queue:lease:${taskId}`;

  const lease = await kv.get<LeaseData>(leaseKey, 'json');
  if (!lease) {
    return { success: true, message: 'No active lease' };
  }

  // Only the lease holder can release (or if workerId not provided, anyone can release)
  if (workerId && lease.workerId !== workerId) {
    return { success: false, error: 'Not lease holder' };
  }

  await kv.delete(leaseKey);
  safeLog.log('[Queue API] Lease released', { taskId, reason: reason || 'manual' });

  return { success: true };
}

/**
 * POST /api/queue/:taskId/renew - Renew a lease
 */
export async function renewLease(
  kv: KVNamespace,
  taskId: string,
  workerId: string,
  extendSec: number
): Promise<{
  success: boolean;
  lease?: LeaseData;
  error?: string;
}> {
  const leaseKey = `queue:lease:${taskId}`;

  const lease = await kv.get<LeaseData>(leaseKey, 'json');
  if (!lease || lease.workerId !== workerId) {
    return { success: false, error: 'Invalid lease or not holder' };
  }

  const renewedLease: LeaseData = {
    ...lease,
    expiresAt: new Date(Date.now() + extendSec * 1000).toISOString(),
    renewedAt: new Date().toISOString(),
  };

  await kv.put(leaseKey, JSON.stringify(renewedLease), { expirationTtl: extendSec });

  return { success: true, lease: renewedLease };
}

/**
 * GET /api/queue/:taskId - Get specific task
 */
export async function getTask(
  kv: KVNamespace,
  taskId: string
): Promise<{
  task?: TaskData;
  error?: string;
}> {
  const task = await kv.get<TaskData>(`queue:task:${taskId}`, 'json');
  if (!task) {
    return { error: 'Task not found' };
  }
  return { task };
}

/**
 * POST /api/queue/:taskId/status - Update task status
 */
export async function updateTaskStatus(
  kv: KVNamespace,
  taskId: string,
  status: string
): Promise<{
  success: boolean;
  status?: string;
  error?: string;
}> {
  const task = await kv.get<TaskData>(`queue:task:${taskId}`, 'json');
  if (!task) {
    return { success: false, error: 'Task not found' };
  }

  // Update task status
  task.status = status as TaskData['status'];
  await kv.put(`queue:task:${taskId}`, JSON.stringify(task), { expirationTtl: 3600 });

  return { success: true, status };
}

/**
 * POST /api/result/:taskId - Store result and remove from queue
 */
export async function storeResultAndComplete(
  kv: KVNamespace,
  taskId: string,
  result: unknown
): Promise<{
  success: boolean;
}> {
  // Store result
  await kv.put(`orchestrator:result:${taskId}`, JSON.stringify(result), {
    expirationTtl: 3600,
  });

  // Delete task key (no need to update pending list anymore)
  await kv.delete(`queue:task:${taskId}`);

  // Delete lease if it exists
  await kv.delete(`queue:lease:${taskId}`);

  return { success: true };
}
