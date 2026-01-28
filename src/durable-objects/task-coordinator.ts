/**
 * TaskCoordinator Durable Object
 *
 * Provides atomic lease coordination for the task queue.
 * Task data remains in KV; this DO only manages lease state to prevent race conditions.
 *
 * ## Architecture
 * - KV stores task data (queue:task:{taskId})
 * - DO stores lease state (lease:{taskId}) with atomic operations
 * - Each DO instance serializes claim/release/renew operations
 *
 * ## Internal API (via fetch)
 * - POST /claim-next - Atomically claim first available task
 * - POST /release - Release a lease
 * - POST /renew - Renew/extend a lease
 * - GET /leases - Get all active leases (monitoring)
 * - DELETE /task/:taskId - Delete lease for a task
 */

import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../types';
import { safeLog } from '../utils/log-sanitizer';

/**
 * Lease record stored in DO storage
 */
interface LeaseRecord {
  workerId: string;
  claimedAt: string;    // ISO timestamp
  expiresAt: string;    // ISO timestamp
  renewedAt?: string;   // ISO timestamp (set on renew)
}

/**
 * Request body for /claim-next
 */
interface ClaimNextRequest {
  candidates: string[];       // Task IDs from KV scan
  workerId: string;
  leaseDurationSec: number;
}

/**
 * Request body for /release
 */
interface ReleaseRequest {
  taskId: string;
  workerId?: string;
}

/**
 * Request body for /renew
 */
interface RenewRequest {
  taskId: string;
  workerId: string;
  extendSec: number;
}

/**
 * TaskCoordinator Durable Object
 *
 * Serializes all lease operations to prevent race conditions.
 * Runs periodic cleanup of expired leases via alarm.
 */
export class TaskCoordinator extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    // Set up periodic cleanup alarm (every 60 seconds)
    this.ctx.storage.setAlarm(Date.now() + 60000);
  }

  /**
   * Handle internal HTTP requests
   * Requires Bearer token matching QUEUE_API_KEY for authentication.
   */
  async fetch(request: Request): Promise<Response> {
    // Verify internal bearer token (prevents unauthorized DO access)
    const expectedKey = this.env.QUEUE_API_KEY;
    if (expectedKey) {
      const authHeader = request.headers.get('Authorization');
      const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
      if (token !== expectedKey) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // POST /claim-next - Atomically claim first available task
      if (path === '/claim-next' && request.method === 'POST') {
        const body: ClaimNextRequest = await request.json();
        return await this.handleClaimNext(body);
      }

      // POST /release - Release a lease
      if (path === '/release' && request.method === 'POST') {
        const body: ReleaseRequest = await request.json();
        return await this.handleRelease(body);
      }

      // POST /renew - Renew a lease
      if (path === '/renew' && request.method === 'POST') {
        const body: RenewRequest = await request.json();
        return await this.handleRenew(body);
      }

      // GET /leases - Get all active leases
      if (path === '/leases' && request.method === 'GET') {
        return await this.handleGetLeases();
      }

      // DELETE /task/:taskId - Delete lease for a task
      const deleteMatch = path.match(/^\/task\/([^/]+)$/);
      if (deleteMatch && request.method === 'DELETE') {
        const taskId = deleteMatch[1];
        return await this.handleDeleteTask(taskId);
      }

      return new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      console.error('[TaskCoordinator] Request error:', error instanceof Error ? error.message : String(error));
      return new Response(JSON.stringify({ error: 'Internal error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  /**
   * Atomically claim first available task from candidates
   */
  private async handleClaimNext(req: ClaimNextRequest): Promise<Response> {
    const { candidates, workerId, leaseDurationSec } = req;

    if (!Array.isArray(candidates) || candidates.length === 0) {
      return new Response(JSON.stringify({
        claimed: false,
        reason: 'No candidates provided'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Iterate candidates and find first unclaimed or expired task
    for (const taskId of candidates) {
      const leaseKey = `lease:${taskId}`;
      const existingLease = await this.ctx.storage.get<LeaseRecord>(leaseKey);

      // Check if lease exists and is still valid
      if (existingLease) {
        const expiresAt = new Date(existingLease.expiresAt).getTime();
        const now = Date.now();

        if (expiresAt > now) {
          // Lease is still valid, skip this task
          safeLog.log('[TaskCoordinator] Task already leased', { taskId, workerId: existingLease.workerId });
          continue;
        }

        // Lease expired, we can claim it
        safeLog.log('[TaskCoordinator] Lease expired, reclaiming', { taskId, expiredWorkerId: existingLease.workerId });
      }

      // Claim this task (atomic write)
      const now = new Date();
      const expiresAt = new Date(now.getTime() + leaseDurationSec * 1000);

      const lease: LeaseRecord = {
        workerId,
        claimedAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
      };

      await this.ctx.storage.put(leaseKey, lease);
      safeLog.log('[TaskCoordinator] Task claimed', { taskId, workerId, leaseDurationSec });

      return new Response(JSON.stringify({
        claimed: true,
        taskId,
        lease,
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // All candidates are claimed
    return new Response(JSON.stringify({
      claimed: false,
      reason: 'All tasks are leased',
      checkedCount: candidates.length,
    }), {
      headers: { 'Content-Type': 'application/json' },
      status: 200,
    });
  }

  /**
   * Release a lease
   */
  private async handleRelease(req: ReleaseRequest): Promise<Response> {
    const { taskId, workerId } = req;

    if (!taskId) {
      return new Response(JSON.stringify({ error: 'taskId is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const leaseKey = `lease:${taskId}`;
    const existingLease = await this.ctx.storage.get<LeaseRecord>(leaseKey);

    if (!existingLease) {
      return new Response(JSON.stringify({
        success: true,
        message: 'No active lease'
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // If workerId provided, verify it matches
    if (workerId && existingLease.workerId !== workerId) {
      return new Response(JSON.stringify({ error: 'Not lease holder' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Delete the lease
    await this.ctx.storage.delete(leaseKey);
    safeLog.log('[TaskCoordinator] Lease released', { taskId, workerId: existingLease.workerId });

    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  /**
   * Renew/extend a lease
   */
  private async handleRenew(req: RenewRequest): Promise<Response> {
    const { taskId, workerId, extendSec } = req;

    if (!taskId || !workerId) {
      return new Response(JSON.stringify({ error: 'taskId and workerId are required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const leaseKey = `lease:${taskId}`;
    const existingLease = await this.ctx.storage.get<LeaseRecord>(leaseKey);

    if (!existingLease) {
      return new Response(JSON.stringify({ error: 'No active lease' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Verify workerId matches
    if (existingLease.workerId !== workerId) {
      return new Response(JSON.stringify({ error: 'Not lease holder' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Extend the lease
    const now = new Date();
    const newExpiresAt = new Date(now.getTime() + extendSec * 1000);

    const updatedLease: LeaseRecord = {
      ...existingLease,
      expiresAt: newExpiresAt.toISOString(),
      renewedAt: now.toISOString(),
    };

    await this.ctx.storage.put(leaseKey, updatedLease);
    safeLog.log('[TaskCoordinator] Lease renewed', { taskId, workerId, extendSec });

    return new Response(JSON.stringify({
      success: true,
      lease: updatedLease,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  /**
   * Get all active leases (for monitoring)
   * Also cleans up expired leases during this call
   */
  private async handleGetLeases(): Promise<Response> {
    const allEntries = await this.ctx.storage.list<LeaseRecord>({ prefix: 'lease:' });
    const leases: Record<string, LeaseRecord> = {};
    const now = Date.now();
    const expiredKeys: string[] = [];

    for (const [key, lease] of allEntries) {
      const taskId = key.replace('lease:', '');
      const expiresAt = new Date(lease.expiresAt).getTime();

      if (expiresAt <= now) {
        // Expired, mark for cleanup
        expiredKeys.push(key);
        safeLog.log('[TaskCoordinator] Expired lease found during listing', { taskId, workerId: lease.workerId });
      } else {
        // Still valid
        leases[taskId] = lease;
      }
    }

    // Clean up expired leases
    if (expiredKeys.length > 0) {
      await this.ctx.storage.delete(expiredKeys);
      safeLog.log('[TaskCoordinator] Cleaned up expired leases', { count: expiredKeys.length });
    }

    return new Response(JSON.stringify({
      leases,
      count: Object.keys(leases).length,
      cleanedUp: expiredKeys.length,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  /**
   * Delete lease for a task (used when task is completed/removed)
   */
  private async handleDeleteTask(taskId: string): Promise<Response> {
    if (!taskId) {
      return new Response(JSON.stringify({ error: 'taskId is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const leaseKey = `lease:${taskId}`;
    await this.ctx.storage.delete(leaseKey);
    safeLog.log('[TaskCoordinator] Task lease deleted', { taskId });

    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  /**
   * Periodic alarm to clean up expired leases
   * Fires every 60 seconds
   */
  async alarm(): Promise<void> {
    safeLog.log('[TaskCoordinator] Alarm triggered, cleaning up expired leases');

    const allEntries = await this.ctx.storage.list<LeaseRecord>({ prefix: 'lease:' });
    const now = Date.now();
    const expiredKeys: string[] = [];

    for (const [key, lease] of allEntries) {
      const expiresAt = new Date(lease.expiresAt).getTime();
      if (expiresAt <= now) {
        expiredKeys.push(key);
        const taskId = key.replace('lease:', '');
        safeLog.log('[TaskCoordinator] Cleaning expired lease', { taskId, workerId: lease.workerId });
      }
    }

    if (expiredKeys.length > 0) {
      await this.ctx.storage.delete(expiredKeys);
      safeLog.log('[TaskCoordinator] Cleaned up expired leases via alarm', { count: expiredKeys.length });
    } else {
      safeLog.log('[TaskCoordinator] No expired leases to clean');
    }

    // Schedule next alarm in 60 seconds
    await this.ctx.storage.setAlarm(Date.now() + 60000);
  }
}
