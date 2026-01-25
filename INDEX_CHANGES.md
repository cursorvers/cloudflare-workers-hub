# Exact Changes for src/index.ts

## Step 1: Add Imports (Top of File)

Add these imports after the existing import statements (around line 32):

```typescript
// Queue Migration
import {
  getMigrationStatusHandler,
  runMigrationHandler,
  rollbackMigrationHandler,
} from './handlers/migration-api';
import {
  listPendingTasks,
  claimTask,
  releaseLease,
  renewLease,
  getTask,
  updateTaskStatus,
  storeResultAndComplete,
} from './handlers/queue-api-new';
```

## Step 2: Add Migration Endpoints

Insert this BEFORE the queue API section (before line 864):

```typescript
  // Migration API endpoints (for queue format migration)
  if (path.startsWith('/api/migrate')) {
    // Verify admin API key for migration endpoints
    if (!verifyAPIKey(request, env, 'admin')) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (path === '/api/migrate/status' && request.method === 'GET') {
      return getMigrationStatusHandler(env.CACHE);
    }

    if (path === '/api/migrate/run' && request.method === 'POST') {
      return runMigrationHandler(env.CACHE);
    }

    if (path === '/api/migrate/rollback' && request.method === 'POST') {
      return rollbackMigrationHandler(env.CACHE);
    }

    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }
```

## Step 3: Replace Queue API Handlers

### 3a. Replace GET /api/queue (around line 864-870)

**FIND:**
```typescript
  // GET /api/queue - List pending tasks
  if (path === '/api/queue' && request.method === 'GET') {
    const pending = await kv.get<string[]>('orchestrator:pending', 'json') || [];
    return new Response(JSON.stringify({ pending, count: pending.length }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }
```

**REPLACE WITH:**
```typescript
  // GET /api/queue - List pending tasks (using KV prefix scan)
  if (path === '/api/queue' && request.method === 'GET') {
    const result = await listPendingTasks(kv);
    return new Response(JSON.stringify(result), {
      headers: { 'Content-Type': 'application/json' },
    });
  }
```

### 3b. Replace POST /api/queue/claim (around line 872-933)

**FIND:**
```typescript
  // POST /api/queue/claim - Atomically claim next available task (lease mechanism)
  if (path === '/api/queue/claim' && request.method === 'POST') {
    const body = await request.json() as { workerId?: string; leaseDurationSec?: number };
    const workerId = body.workerId || `worker_${Date.now()}`;
    const leaseDuration = Math.min(body.leaseDurationSec || 300, 600); // Max 10 minutes

    const pending = await kv.get<string[]>('orchestrator:pending', 'json') || [];

    // Find first task that isn't already leased
    for (const taskId of pending) {
      const leaseKey = `orchestrator:lease:${taskId}`;
      const existingLease = await kv.get(leaseKey);

      if (existingLease) {
        // Task already leased by another worker
        continue;
      }

      // Try to acquire lease (atomic via KV put)
      const leaseData = {
        workerId,
        claimedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + leaseDuration * 1000).toISOString(),
      };

      await kv.put(leaseKey, JSON.stringify(leaseData), { expirationTtl: leaseDuration });

      // Verify we got the lease (in case of race condition)
      const verifyLease = await kv.get<typeof leaseData>(leaseKey, 'json');
      if (verifyLease?.workerId !== workerId) {
        // Lost race, try next task
        continue;
      }

      // Successfully claimed - fetch task details
      const task = await kv.get(`orchestrator:queue:${taskId}`, 'json');
      if (!task) {
        // Task was deleted, release lease and try next
        await kv.delete(leaseKey);
        continue;
      }

      safeLog.log('[Queue API] Task claimed', { taskId, workerId, leaseDuration });

      return new Response(JSON.stringify({
        success: true,
        taskId,
        task,
        lease: leaseData,
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // No available tasks
    return new Response(JSON.stringify({
      success: false,
      message: 'No tasks available or all tasks are leased',
      pending: pending.length,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }
```

**REPLACE WITH:**
```typescript
  // POST /api/queue/claim - Atomically claim next available task (lease mechanism)
  if (path === '/api/queue/claim' && request.method === 'POST') {
    const body = await request.json() as { workerId?: string; leaseDurationSec?: number };
    const workerId = body.workerId || `worker_${Date.now()}`;
    const leaseDuration = Math.min(body.leaseDurationSec || 300, 600); // Max 10 minutes

    const result = await claimTask(kv, workerId, leaseDuration);

    return new Response(JSON.stringify(result), {
      headers: { 'Content-Type': 'application/json' },
    });
  }
```

### 3c. Replace POST /api/queue/:taskId/release (around line 935-876)

**FIND:**
```typescript
  // POST /api/queue/:taskId/release - Release a lease (on failure or cancellation)
  const releaseMatch = path.match(/^\/api\/queue\/([^/]+)\/release$/);
  if (releaseMatch && request.method === 'POST') {
    const taskId = releaseMatch[1];
    const body = await request.json() as { workerId?: string; reason?: string };
    const leaseKey = `orchestrator:lease:${taskId}`;

    const lease = await kv.get<{ workerId: string }>(leaseKey, 'json');
    if (!lease) {
      return new Response(JSON.stringify({ success: true, message: 'No active lease' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Only the lease holder can release (or if workerId not provided, anyone can release)
    if (body.workerId && lease.workerId !== body.workerId) {
      return new Response(JSON.stringify({ error: 'Not lease holder' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    await kv.delete(leaseKey);
    safeLog.log('[Queue API] Lease released', { taskId, reason: body.reason || 'manual' });

    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }
```

**REPLACE WITH:**
```typescript
  // POST /api/queue/:taskId/release - Release a lease (on failure or cancellation)
  const releaseMatch = path.match(/^\/api\/queue\/([^/]+)\/release$/);
  if (releaseMatch && request.method === 'POST') {
    const taskId = releaseMatch[1];
    const body = await request.json() as { workerId?: string; reason?: string };

    const result = await releaseLease(kv, taskId, body.workerId, body.reason);

    return new Response(JSON.stringify(result), {
      status: result.success ? 200 : 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }
```

### 3d. Replace POST /api/queue/:taskId/renew (around line 878-905)

**FIND:**
```typescript
  // POST /api/queue/:taskId/renew - Renew a lease (extend TTL)
  const renewMatch = path.match(/^\/api\/queue\/([^/]+)\/renew$/);
  if (renewMatch && request.method === 'POST') {
    const taskId = renewMatch[1];
    const body = await request.json() as { workerId: string; extendSec?: number };
    const leaseKey = `orchestrator:lease:${taskId}`;
    const extendDuration = Math.min(body.extendSec || 300, 600);

    const lease = await kv.get<{ workerId: string; claimedAt: string }>(leaseKey, 'json');
    if (!lease || lease.workerId !== body.workerId) {
      return new Response(JSON.stringify({ error: 'Invalid lease or not holder' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const renewedLease = {
      ...lease,
      expiresAt: new Date(Date.now() + extendDuration * 1000).toISOString(),
      renewedAt: new Date().toISOString(),
    };

    await kv.put(leaseKey, JSON.stringify(renewedLease), { expirationTtl: extendDuration });

    return new Response(JSON.stringify({ success: true, lease: renewedLease }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }
```

**REPLACE WITH:**
```typescript
  // POST /api/queue/:taskId/renew - Renew a lease (extend TTL)
  const renewMatch = path.match(/^\/api\/queue\/([^/]+)\/renew$/);
  if (renewMatch && request.method === 'POST') {
    const taskId = renewMatch[1];
    const body = await request.json() as { workerId: string; extendSec?: number };
    const extendDuration = Math.min(body.extendSec || 300, 600);

    const result = await renewLease(kv, taskId, body.workerId, extendDuration);

    return new Response(JSON.stringify(result), {
      status: result.success ? 200 : 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }
```

### 3e. Replace GET /api/queue/:taskId (around line 907-921)

**FIND:**
```typescript
  // GET /api/queue/:taskId - Get specific task
  const taskMatch = path.match(/^\/api\/queue\/([^/]+)$/);
  if (taskMatch && request.method === 'GET') {
    const taskId = taskMatch[1];
    const task = await kv.get(`orchestrator:queue:${taskId}`, 'json');
    if (!task) {
      return new Response(JSON.stringify({ error: 'Task not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify(task), {
      headers: { 'Content-Type': 'application/json' },
    });
  }
```

**REPLACE WITH:**
```typescript
  // GET /api/queue/:taskId - Get specific task
  const taskMatch = path.match(/^\/api\/queue\/([^/]+)$/);
  if (taskMatch && request.method === 'GET') {
    const taskId = taskMatch[1];

    const result = await getTask(kv, taskId);

    if (result.error) {
      return new Response(JSON.stringify({ error: result.error }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify(result.task), {
      headers: { 'Content-Type': 'application/json' },
    });
  }
```

### 3f. Replace POST /api/queue/:taskId/status (around line 923-945)

**FIND:**
```typescript
  // POST /api/queue/:taskId/status - Update task status
  const statusMatch = path.match(/^\/api\/queue\/([^/]+)\/status$/);
  if (statusMatch && request.method === 'POST') {
    const taskId = statusMatch[1];
    const body = await request.json() as { status: string };

    const task = await kv.get(`orchestrator:queue:${taskId}`, 'json') as Record<string, unknown> | null;
    if (!task) {
      return new Response(JSON.stringify({ error: 'Task not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Update task status
    task.status = body.status;
    task.updatedAt = new Date().toISOString();
    await kv.put(`orchestrator:queue:${taskId}`, JSON.stringify(task), { expirationTtl: 3600 });

    return new Response(JSON.stringify({ success: true, status: body.status }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }
```

**REPLACE WITH:**
```typescript
  // POST /api/queue/:taskId/status - Update task status
  const statusMatch = path.match(/^\/api\/queue\/([^/]+)\/status$/);
  if (statusMatch && request.method === 'POST') {
    const taskId = statusMatch[1];
    const body = await request.json() as { status: string };

    const result = await updateTaskStatus(kv, taskId, body.status);

    if (!result.success) {
      return new Response(JSON.stringify({ error: result.error }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify(result), {
      headers: { 'Content-Type': 'application/json' },
    });
  }
```

### 3g. Replace POST /api/result/:taskId (around line 947-967)

**FIND:**
```typescript
  // POST /api/result/:taskId - Store result and remove from queue
  const resultMatch = path.match(/^\/api\/result\/([^/]+)$/);
  if (resultMatch && request.method === 'POST') {
    const taskId = resultMatch[1];
    const result = await request.json();

    // Store result
    await kv.put(`orchestrator:result:${taskId}`, JSON.stringify(result), {
      expirationTtl: 3600,
    });

    // Remove from pending list
    const pendingList = await kv.get<string[]>('orchestrator:pending', 'json') || [];
    const updatedList = pendingList.filter(id => id !== taskId);
    await kv.put('orchestrator:pending', JSON.stringify(updatedList), { expirationTtl: 3600 });

    // Delete queue entry
    await kv.delete(`orchestrator:queue:${taskId}`);

    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }
```

**REPLACE WITH:**
```typescript
  // POST /api/result/:taskId - Store result and remove from queue
  const resultMatch = path.match(/^\/api\/result\/([^/]+)$/);
  if (resultMatch && request.method === 'POST') {
    const taskId = resultMatch[1];
    const result = await request.json();

    await storeResultAndComplete(kv, taskId, result);

    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }
```

## Summary of Changes

| Section | Lines (approx) | Action |
|---------|---------------|--------|
| Imports | ~32 | Add migration and new queue API imports |
| Migration endpoints | Before 864 | Insert new migration API section |
| GET /api/queue | 864-870 | Replace with `listPendingTasks()` call |
| POST /api/queue/claim | 872-933 | Replace with `claimTask()` call |
| POST /api/queue/:id/release | 935-876 | Replace with `releaseLease()` call |
| POST /api/queue/:id/renew | 878-905 | Replace with `renewLease()` call |
| GET /api/queue/:id | 907-921 | Replace with `getTask()` call |
| POST /api/queue/:id/status | 923-945 | Replace with `updateTaskStatus()` call |
| POST /api/result/:id | 947-967 | Replace with `storeResultAndComplete()` call |

## Total Lines Removed

Approximately **150 lines** of old queue logic replaced with **80 lines** of cleaner handler calls.

## Net Result

- Simpler `src/index.ts`
- Better separation of concerns
- Easier to test (handlers are isolated)
- Migration path provided via `/api/migrate/*` endpoints
