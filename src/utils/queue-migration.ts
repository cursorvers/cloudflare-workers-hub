/**
 * Queue Migration Utilities
 *
 * Migrate from single pending list to KV prefix scan
 */

import { safeLog } from './log-sanitizer';

export interface TaskData {
  id: string;
  type: 'task' | 'query' | 'approval' | 'notification';
  source: string;
  content: string;
  priority: 'low' | 'medium' | 'high' | 'critical';
  metadata: Record<string, unknown>;
  queuedAt: string;
  status: 'pending' | 'claimed' | 'completed' | 'failed';
  createdAt?: string;
}

/**
 * Migrate existing tasks from old format to new format
 *
 * Old: orchestrator:queue:{taskId} + orchestrator:pending array
 * New: queue:task:{taskId} (no pending array)
 */
export async function migrateQueueToNewFormat(kv: KVNamespace): Promise<{
  migrated: number;
  failed: number;
  errors: string[];
}> {
  const errors: string[] = [];
  let migrated = 0;
  let failed = 0;

  try {
    // Get old pending list
    const oldPending = await kv.get<string[]>('orchestrator:pending', 'json') || [];

    safeLog.log(`[Migration] Found ${oldPending.length} tasks in old pending list`);

    // Migrate each task
    for (const taskId of oldPending) {
      try {
        // Read from old key
        const oldKey = `orchestrator:queue:${taskId}`;
        const taskData = await kv.get<TaskData>(oldKey, 'json');

        if (!taskData) {
          safeLog.warn(`[Migration] Task ${taskId} not found in old queue`);
          failed++;
          errors.push(`Task ${taskId}: not found in old queue`);
          continue;
        }

        // Write to new key
        const newKey = `queue:task:${taskId}`;
        await kv.put(newKey, JSON.stringify(taskData), { expirationTtl: 3600 });

        // Verify write
        const verified = await kv.get(newKey);
        if (!verified) {
          throw new Error('Failed to verify new key write');
        }

        // Delete old key (only after successful verification)
        await kv.delete(oldKey);

        migrated++;
        safeLog.log(`[Migration] Migrated task ${taskId}`);
      } catch (error) {
        failed++;
        const errorMsg = `Task ${taskId}: ${String(error)}`;
        errors.push(errorMsg);
        safeLog.error(`[Migration] Failed to migrate task ${taskId}:`, error);
      }
    }

    // Delete old pending list (only if at least one task migrated successfully)
    if (migrated > 0) {
      await kv.delete('orchestrator:pending');
      safeLog.log('[Migration] Deleted old pending list');
    }

    safeLog.log(`[Migration] Complete: ${migrated} migrated, ${failed} failed`);

    return { migrated, failed, errors };
  } catch (error) {
    safeLog.error('[Migration] Fatal error:', error);
    return {
      migrated,
      failed,
      errors: [...errors, `Fatal: ${String(error)}`],
    };
  }
}

/**
 * Migrate old lease keys to new format
 *
 * Old: orchestrator:lease:{taskId}
 * New: queue:lease:{taskId}
 */
export async function migrateLeases(kv: KVNamespace): Promise<{
  migrated: number;
  failed: number;
  errors: string[];
}> {
  const errors: string[] = [];
  let migrated = 0;
  let failed = 0;

  try {
    // List all old lease keys
    const oldLeases = await kv.list({ prefix: 'orchestrator:lease:' });

    safeLog.log(`[Migration] Found ${oldLeases.keys.length} old lease keys`);

    for (const key of oldLeases.keys) {
      try {
        const leaseData = await kv.get(key.name, 'json');

        if (!leaseData) {
          safeLog.warn(`[Migration] Lease ${key.name} has no data`);
          continue;
        }

        // Extract taskId and create new key
        const taskId = key.name.replace('orchestrator:lease:', '');
        const newKey = `queue:lease:${taskId}`;

        // Get original TTL if available (metadata)
        const ttl = key.expiration ? Math.max(key.expiration - Math.floor(Date.now() / 1000), 60) : 300;

        // Write to new key
        await kv.put(newKey, JSON.stringify(leaseData), { expirationTtl: ttl });

        // Verify write
        const verified = await kv.get(newKey);
        if (!verified) {
          throw new Error('Failed to verify new lease key write');
        }

        // Delete old key
        await kv.delete(key.name);

        migrated++;
        safeLog.log(`[Migration] Migrated lease ${taskId}`);
      } catch (error) {
        failed++;
        const errorMsg = `Lease ${key.name}: ${String(error)}`;
        errors.push(errorMsg);
        safeLog.error(`[Migration] Failed to migrate lease ${key.name}:`, error);
      }
    }

    safeLog.log(`[Migration] Leases complete: ${migrated} migrated, ${failed} failed`);

    return { migrated, failed, errors };
  } catch (error) {
    safeLog.error('[Migration] Fatal error migrating leases:', error);
    return {
      migrated,
      failed,
      errors: [...errors, `Fatal: ${String(error)}`],
    };
  }
}

/**
 * Check if migration is needed
 */
export async function needsMigration(kv: KVNamespace): Promise<boolean> {
  const oldPending = await kv.get('orchestrator:pending');
  return oldPending !== null;
}

/**
 * Get migration status
 */
export async function getMigrationStatus(kv: KVNamespace): Promise<{
  oldFormatExists: boolean;
  newFormatExists: boolean;
  oldTaskCount: number;
  newTaskCount: number;
  oldLeaseCount: number;
  newLeaseCount: number;
}> {
  const oldPending = await kv.get<string[]>('orchestrator:pending', 'json');
  const newTasks = await kv.list({ prefix: 'queue:task:' });
  const oldLeases = await kv.list({ prefix: 'orchestrator:lease:' });
  const newLeases = await kv.list({ prefix: 'queue:lease:' });

  return {
    oldFormatExists: oldPending !== null,
    newFormatExists: newTasks.keys.length > 0,
    oldTaskCount: oldPending?.length || 0,
    newTaskCount: newTasks.keys.length,
    oldLeaseCount: oldLeases.keys.length,
    newLeaseCount: newLeases.keys.length,
  };
}
