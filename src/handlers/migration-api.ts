/**
 * Migration API Handlers
 *
 * Provides endpoints for queue migration management
 */

import {
  migrateQueueToNewFormat,
  migrateLeases,
  needsMigration,
  getMigrationStatus,
} from '../utils/queue-migration';
import { safeLog } from '../utils/log-sanitizer';

/**
 * GET /api/migrate/status - Check migration status
 */
export async function getMigrationStatusHandler(kv: KVNamespace): Promise<Response> {
  try {
    const status = await getMigrationStatus(kv);

    return new Response(JSON.stringify({
      success: true,
      status,
      needsMigration: status.oldFormatExists,
      recommendation: status.oldFormatExists
        ? 'Run migration to move to new format'
        : 'Already using new format',
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    safeLog.error('[Migration API] Failed to get status', { error: String(error) });
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to get migration status',
      type: 'internal_error',
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

/**
 * POST /api/migrate/run - Execute migration
 */
export async function runMigrationHandler(kv: KVNamespace): Promise<Response> {
  try {
    // Check if migration is needed
    const needed = await needsMigration(kv);

    if (!needed) {
      return new Response(JSON.stringify({
        success: true,
        message: 'Migration not needed - already using new format',
        tasks: { migrated: 0, failed: 0, errors: [] },
        leases: { migrated: 0, failed: 0, errors: [] },
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    safeLog.log('[Migration API] Starting migration');

    // Migrate tasks
    const taskResult = await migrateQueueToNewFormat(kv);
    safeLog.log('[Migration API] Task migration complete', taskResult);

    // Migrate leases
    const leaseResult = await migrateLeases(kv);
    safeLog.log('[Migration API] Lease migration complete', leaseResult);

    const allErrors = [...taskResult.errors, ...leaseResult.errors];
    const totalFailed = taskResult.failed + leaseResult.failed;

    return new Response(JSON.stringify({
      success: totalFailed === 0,
      message: totalFailed === 0
        ? 'Migration completed successfully'
        : `Migration completed with ${totalFailed} failures`,
      tasks: taskResult,
      leases: leaseResult,
      totalMigrated: taskResult.migrated + leaseResult.migrated,
      totalFailed,
      errors: allErrors,
    }), {
      status: totalFailed > 0 ? 207 : 200, // 207 Multi-Status for partial success
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    safeLog.error('[Migration API] Migration failed', { error: String(error) });
    return new Response(JSON.stringify({
      success: false,
      error: 'Migration failed',
      type: 'internal_error',
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

/**
 * POST /api/migrate/rollback - Rollback migration (emergency)
 *
 * This is an emergency endpoint that shouldn't normally be needed
 * since old keys are deleted only after verification
 */
export async function rollbackMigrationHandler(kv: KVNamespace): Promise<Response> {
  try {
    safeLog.warn('[Migration API] Rollback requested - this should be rare');

    // List all new format keys
    const newTasks = await kv.list({ prefix: 'queue:task:' });
    const newLeases = await kv.list({ prefix: 'queue:lease:' });

    let deleted = 0;

    // Delete new task keys
    for (const key of newTasks.keys) {
      await kv.delete(key.name);
      deleted++;
    }

    // Delete new lease keys
    for (const key of newLeases.keys) {
      await kv.delete(key.name);
      deleted++;
    }

    safeLog.log('[Migration API] Rollback complete', { deleted });

    return new Response(JSON.stringify({
      success: true,
      message: `Rollback complete - deleted ${deleted} new format keys`,
      deleted,
      note: 'Old format keys remain intact if they still exist',
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    safeLog.error('[Migration API] Rollback failed', { error: String(error) });
    return new Response(JSON.stringify({
      success: false,
      error: 'Rollback failed',
      type: 'internal_error',
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
