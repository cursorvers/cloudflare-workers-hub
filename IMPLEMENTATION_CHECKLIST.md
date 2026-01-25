# Implementation Checklist

## Quick Start

Follow these steps to complete the migration:

### Step 1: Review Changes

- [x] Migration utilities created (`src/utils/queue-migration.ts`)
- [x] New queue API handlers created (`src/handlers/queue-api-new.ts`)
- [x] Migration API handlers created (`src/handlers/migration-api.ts`)
- [x] CommHub adapter updated (`src/adapters/commhub.ts`)
- [x] Documentation created (`docs/QUEUE_MIGRATION.md`)

### Step 2: Integrate into Main Handler

Edit `src/index.ts`:

```typescript
// 1. Add imports at the top
import {
  getMigrationStatusHandler,
  runMigrationHandler,
  rollbackMigrationHandler,
} from './handlers/migration-api';
import {
  listPendingTasks,
  claimTask,
  storeResultAndComplete,
} from './handlers/queue-api-new';

// 2. Add migration endpoints (before queue API section)
// Around line 860, add:

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
}

// 3. Replace queue API handlers (around lines 864-933)
// Replace the GET /api/queue handler:
if (path === '/api/queue' && request.method === 'GET') {
  const result = await listPendingTasks(kv);
  return new Response(JSON.stringify(result), {
    headers: { 'Content-Type': 'application/json' },
  });
}

// Replace the POST /api/queue/claim handler:
if (path === '/api/queue/claim' && request.method === 'POST') {
  const body = await request.json() as { workerId?: string; leaseDurationSec?: number };
  const workerId = body.workerId || `worker_${Date.now()}`;
  const leaseDuration = Math.min(body.leaseDurationSec || 300, 600);

  const result = await claimTask(kv, workerId, leaseDuration);

  return new Response(JSON.stringify(result), {
    headers: { 'Content-Type': 'application/json' },
  });
}

// Replace the POST /api/result/:taskId handler (around line 947):
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

### Step 3: Build and Test Locally

```bash
# Install dependencies
npm install

# Build
npm run build

# Test locally (if you have wrangler dev)
npm run dev

# Test migration status endpoint
curl -H "X-API-Key: your-admin-key" \
  http://localhost:8787/api/migrate/status
```

### Step 4: Deploy to Staging

```bash
# Deploy
npm run deploy

# Or with wrangler directly
wrangler deploy
```

### Step 5: Run Migration

```bash
# Check status
curl -H "X-API-Key: $ADMIN_API_KEY" \
  https://your-worker.workers.dev/api/migrate/status

# Run migration
curl -X POST -H "X-API-Key: $ADMIN_API_KEY" \
  https://your-worker.workers.dev/api/migrate/run
```

Expected response:
```json
{
  "success": true,
  "message": "Migration completed successfully",
  "tasks": { "migrated": 5, "failed": 0, "errors": [] },
  "leases": { "migrated": 2, "failed": 0, "errors": [] },
  "totalMigrated": 7,
  "totalFailed": 0
}
```

### Step 6: Verify New Format

```bash
# List tasks (should use prefix scan)
curl -H "X-API-Key: $QUEUE_API_KEY" \
  https://your-worker.workers.dev/api/queue

# Try claiming a task
curl -X POST -H "X-API-Key: $QUEUE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"workerId": "test-worker-1", "leaseDurationSec": 300}' \
  https://your-worker.workers.dev/api/queue/claim
```

### Step 7: Update Daemon

If you have an external daemon polling the queue:

```bash
# Update daemon to use new API (no changes needed - API is compatible)
# Just ensure daemon is using /api/queue/claim correctly

# Test daemon claiming
# (Run your daemon's claim logic)
```

### Step 8: Monitor

Check CloudFlare dashboard for:
- [ ] No errors in logs
- [ ] Queue API requests succeeding
- [ ] KV operations using `queue:task:*` keys
- [ ] No `orchestrator:pending` reads/writes

## Rollback Plan (If Needed)

If migration causes issues:

```bash
# 1. Emergency rollback
curl -X POST -H "X-API-Key: $ADMIN_API_KEY" \
  https://your-worker.workers.dev/api/migrate/rollback

# 2. Redeploy old version
git revert HEAD
npm run deploy

# 3. Investigate issues
```

## Verification Checklist

After migration:

- [ ] `/api/queue` returns tasks via prefix scan
- [ ] `/api/queue/claim` successfully claims tasks
- [ ] `/api/result/:taskId` deletes tasks correctly
- [ ] No `orchestrator:pending` key in KV
- [ ] All tasks use `queue:task:*` format
- [ ] Leases use `queue:lease:*` format
- [ ] Daemon can claim and process tasks
- [ ] No contention errors in logs

## Key Files

| File | Purpose |
|------|---------|
| `src/utils/queue-migration.ts` | Migration logic |
| `src/handlers/queue-api-new.ts` | New queue API handlers |
| `src/handlers/migration-api.ts` | Migration HTTP endpoints |
| `src/adapters/commhub.ts` | Updated to use new keys |
| `docs/QUEUE_MIGRATION.md` | Full migration guide |
| `MIGRATION_SUMMARY.md` | Implementation summary |

## Support

If you encounter issues:

1. Check CloudFlare logs for errors
2. Use `/api/migrate/status` to verify state
3. Check KV keys directly via `wrangler kv:key list`
4. Refer to `docs/QUEUE_MIGRATION.md` troubleshooting section

## Success Criteria

✅ Migration complete when:
- All tasks in new format (`queue:task:*`)
- No old format keys remain
- Daemon successfully claiming and processing tasks
- No errors in production logs for 24 hours
