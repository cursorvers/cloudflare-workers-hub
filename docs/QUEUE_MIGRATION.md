# Queue Migration Guide

## Overview

This document guides you through migrating from the single pending list to KV prefix scan architecture.

## What Changed

### Before (Old Format)

```
orchestrator:pending → ["task1", "task2", "task3"]  (single array)
orchestrator:queue:task1 → { task data }
orchestrator:queue:task2 → { task data }
orchestrator:lease:task1 → { lease data }
```

**Problem**: Single key contention when multiple workers claim tasks simultaneously.

### After (New Format)

```
queue:task:task1 → { task data }
queue:task:task2 → { task data }
queue:task:task3 → { task data }
queue:lease:task1 → { lease data }
```

**Solution**: No pending list - use `kv.list({ prefix: 'queue:task:' })` to discover tasks.

## Benefits

1. **No Contention**: Each task is an independent key
2. **Better Scalability**: KV prefix scan handles thousands of tasks
3. **Atomic Operations**: Lease acquisition is still atomic per task
4. **Simpler Logic**: No need to maintain consistency between pending list and task keys

## Migration Steps

### 1. Check Migration Status

```bash
curl -H "X-API-Key: $QUEUE_API_KEY" \
  https://your-worker.workers.dev/api/migrate/status
```

Response:
```json
{
  "success": true,
  "status": {
    "oldFormatExists": true,
    "newFormatExists": false,
    "oldTaskCount": 5,
    "newTaskCount": 0,
    "oldLeaseCount": 2,
    "newLeaseCount": 0
  },
  "needsMigration": true,
  "recommendation": "Run migration to move to new format"
}
```

### 2. Run Migration

```bash
curl -X POST -H "X-API-Key: $QUEUE_API_KEY" \
  https://your-worker.workers.dev/api/migrate/run
```

Response:
```json
{
  "success": true,
  "message": "Migration completed successfully",
  "tasks": {
    "migrated": 5,
    "failed": 0,
    "errors": []
  },
  "leases": {
    "migrated": 2,
    "failed": 0,
    "errors": []
  },
  "totalMigrated": 7,
  "totalFailed": 0,
  "errors": []
}
```

### 3. Verify New Format

```bash
curl -H "X-API-Key: $QUEUE_API_KEY" \
  https://your-worker.workers.dev/api/queue
```

Should return tasks discovered via prefix scan.

### 4. Test Task Claiming

```bash
curl -X POST -H "X-API-Key: $QUEUE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"workerId": "test-worker", "leaseDurationSec": 300}' \
  https://your-worker.workers.dev/api/queue/claim
```

Should claim a task from the new format.

## Migration Process Details

### What the Migration Does

1. **Read Old Pending List**: Gets `orchestrator:pending` array
2. **For Each Task**:
   - Read from `orchestrator:queue:{taskId}`
   - Write to `queue:task:{taskId}`
   - Verify write succeeded
   - Delete `orchestrator:queue:{taskId}` (only after verification)
3. **For Each Lease**:
   - List all `orchestrator:lease:*` keys
   - For each lease:
     - Read data
     - Write to `queue:lease:{taskId}`
     - Verify write succeeded
     - Delete old lease key
4. **Clean Up**: Delete `orchestrator:pending` list

### Safety Features

- **Verification**: Each write is verified before deleting old key
- **Atomic Per Task**: Each task migrates independently
- **Error Collection**: Failed migrations are reported but don't stop the process
- **Rollback Available**: Emergency rollback endpoint (see below)

## Rollback (Emergency Only)

If migration causes issues:

```bash
curl -X POST -H "X-API-Key: $QUEUE_API_KEY" \
  https://your-worker.workers.dev/api/migrate/rollback
```

This deletes all new format keys. Old keys remain intact (if not already deleted).

**Warning**: Only use this if migration went wrong. After rollback, you'll need to redeploy the old code version.

## Backward Compatibility

The migration is **one-way**. The new code doesn't support the old format.

### Deployment Strategy

1. **Run migration** while old daemon is still running
2. **Old daemon** will fail to find tasks (pending list is empty)
3. **Deploy new daemon** immediately after migration
4. **New daemon** discovers tasks via prefix scan

### Zero-Downtime Migration

For zero downtime:

1. Deploy new worker code (accepts both formats temporarily)
2. Run migration
3. Verify new format works
4. Remove old format support code

## Code Changes

### CommHub Adapter

**Before**:
```typescript
const queueKey = `orchestrator:queue:${request.id}`;
const pendingList = await kv.get<string[]>('orchestrator:pending', 'json') || [];
pendingList.push(request.id);
await kv.put('orchestrator:pending', JSON.stringify(pendingList), { expirationTtl: 3600 });
```

**After**:
```typescript
const queueKey = `queue:task:${request.id}`;
await kv.put(queueKey, JSON.stringify(taskData), { expirationTtl: 3600 });
// No pending list update needed
```

### Queue API

**Before**:
```typescript
const pending = await kv.get<string[]>('orchestrator:pending', 'json') || [];
for (const taskId of pending) {
  // claim logic
}
```

**After**:
```typescript
const taskKeys = await kv.list({ prefix: 'queue:task:' });
for (const key of taskKeys.keys) {
  const taskId = key.name.replace('queue:task:', '');
  // claim logic
}
```

## Performance Implications

### Before

- **List Tasks**: O(1) - read single key
- **Claim Task**: O(n) - iterate array, worst case read all tasks
- **Add Task**: O(n) - read array, append, write back (contention!)
- **Remove Task**: O(n) - read array, filter, write back (contention!)

### After

- **List Tasks**: O(n) - KV prefix scan (efficient at scale)
- **Claim Task**: O(n) - iterate KV keys, same as before
- **Add Task**: O(1) - write single key (no contention!)
- **Remove Task**: O(1) - delete single key (no contention!)

**Trade-off**: Listing is slightly slower, but adding/removing is much faster and doesn't have contention.

## Monitoring

After migration, monitor:

1. **Task Discovery**: Ensure `/api/queue` returns correct task count
2. **Claim Success Rate**: Workers should claim tasks successfully
3. **Lease Expiry**: Expired leases should allow re-claiming
4. **No Orphans**: No tasks stuck in "pending" state

## Troubleshooting

### Migration Failed Partially

Check the `errors` array in migration response:

```json
{
  "tasks": {
    "migrated": 3,
    "failed": 2,
    "errors": [
      "Task task4: Failed to verify new key write",
      "Task task5: not found in old queue"
    ]
  }
}
```

**Solution**: Check KV directly for failed tasks and migrate manually if needed.

### Daemon Can't Find Tasks

**Symptoms**: `/api/queue` returns empty, but tasks exist in KV.

**Check**:
```bash
# List keys directly via wrangler
wrangler kv:key list --binding=CACHE --prefix="queue:task:"
```

**Solution**: Ensure daemon is using new code that scans with `queue:task:` prefix.

### Tasks Stuck in "Claimed" State

**Symptoms**: All tasks show as leased, none can be claimed.

**Check**:
```bash
wrangler kv:key list --binding=CACHE --prefix="queue:lease:"
```

**Solution**: Delete expired leases manually:
```bash
wrangler kv:key delete --binding=CACHE "queue:lease:{taskId}"
```

Or wait for TTL to expire naturally (default 300s).

## API Reference

### Migration Endpoints

All require `X-API-Key` header with `QUEUE_API_KEY` or `ADMIN_API_KEY`.

#### GET /api/migrate/status

Returns current migration status.

**Response**:
```typescript
{
  success: boolean;
  status: {
    oldFormatExists: boolean;
    newFormatExists: boolean;
    oldTaskCount: number;
    newTaskCount: number;
    oldLeaseCount: number;
    newLeaseCount: number;
  };
  needsMigration: boolean;
  recommendation: string;
}
```

#### POST /api/migrate/run

Executes migration from old to new format.

**Response**:
```typescript
{
  success: boolean;
  message: string;
  tasks: {
    migrated: number;
    failed: number;
    errors: string[];
  };
  leases: {
    migrated: number;
    failed: number;
    errors: string[];
  };
  totalMigrated: number;
  totalFailed: number;
  errors: string[];
}
```

#### POST /api/migrate/rollback

Emergency rollback - deletes all new format keys.

**Response**:
```typescript
{
  success: boolean;
  message: string;
  deleted: number;
  note: string;
}
```

## Testing

### Unit Tests

```typescript
import { migrateQueueToNewFormat } from './utils/queue-migration';

// Mock KV namespace
const mockKV = {
  get: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  list: vi.fn(),
};

test('migrates tasks correctly', async () => {
  mockKV.get.mockResolvedValueOnce(['task1', 'task2']); // old pending list
  mockKV.get.mockResolvedValueOnce({ id: 'task1', content: 'test' }); // task1 data

  const result = await migrateQueueToNewFormat(mockKV as any);

  expect(result.migrated).toBe(2);
  expect(result.failed).toBe(0);
  expect(mockKV.put).toHaveBeenCalledWith(
    'queue:task:task1',
    expect.any(String),
    { expirationTtl: 3600 }
  );
});
```

### Integration Tests

```bash
# 1. Populate old format
curl -X POST -H "X-API-Key: $QUEUE_API_KEY" \
  https://your-worker.workers.dev/webhook/slack \
  -d '{"event": {"text": "test"}}'

# 2. Verify old format
curl -H "X-API-Key: $QUEUE_API_KEY" \
  https://your-worker.workers.dev/api/queue

# 3. Run migration
curl -X POST -H "X-API-Key: $QUEUE_API_KEY" \
  https://your-worker.workers.dev/api/migrate/run

# 4. Verify new format
curl -H "X-API-Key: $QUEUE_API_KEY" \
  https://your-worker.workers.dev/api/queue

# 5. Test claiming
curl -X POST -H "X-API-Key: $QUEUE_API_KEY" \
  https://your-worker.workers.dev/api/queue/claim \
  -d '{"workerId": "test"}'
```

## Summary

| Aspect | Old Format | New Format |
|--------|-----------|------------|
| Task Discovery | Single array | KV prefix scan |
| Contention | High (single key) | Low (individual keys) |
| Scalability | Limited (~1000 tasks) | High (~millions) |
| Add/Remove Speed | O(n) | O(1) |
| List Speed | O(1) | O(n) |

**Recommendation**: Migrate for any production deployment with >10 tasks or >2 workers.
