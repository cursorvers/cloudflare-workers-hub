# FUGUE Cockpit WebSocket Implementation

Real-time communication between Local Agent (Mac) and Workers Hub for FUGUE Cockpit monitoring.

## Architecture

```
Local Agent (Mac)
    ↓ WebSocket Connection
Workers Hub (/api/ws)
    ↓ Upgrade to Durable Object
CockpitWebSocket DO
    ↓ Store State
D1 Database (cockpit_tasks, cockpit_git_repos, cockpit_alerts)
```

## Components

### 1. CockpitWebSocket Durable Object
**File**: `src/durable-objects/cockpit-websocket.ts`

- Manages WebSocket connections from Local Agents
- Validates messages with Zod schemas
- Stores agent connection state in DO storage
- Broadcasts tasks to connected agents
- Periodic ping/pong for health checks (every 60s)

### 2. Cockpit API Handler
**File**: `src/handlers/cockpit-api.ts`

REST API endpoints:
- `GET /api/cockpit/tasks` - List tasks with filters (status, executor, pagination)
- `POST /api/cockpit/tasks` - Create task and broadcast to agents
- `GET /api/cockpit/repos` - List git repository states
- `GET /api/cockpit/alerts` - List alerts with filters (severity, acknowledged)
- `POST /api/cockpit/alerts/ack/:id` - Acknowledge an alert

### 3. Database Tables
**Migration**: `migrations/0005_cockpit_tables.sql`

- `cockpit_tasks`: Task management
- `cockpit_git_repos`: Git repository state
- `cockpit_alerts`: Alert integration

## Message Protocol

### Incoming (from Local Agent)

```typescript
// Agent status update
{
  type: 'agent-status',
  agentId: string,
  status: 'online' | 'offline' | 'busy' | 'idle',
  capabilities?: string[],
  metadata?: Record<string, unknown>
}

// Git status update
{
  type: 'git-status',
  repos: [
    {
      id: string,
      path: string,
      name: string,
      branch?: string,
      status?: 'clean' | 'dirty' | 'ahead' | 'behind' | 'diverged',
      uncommittedCount?: number,
      aheadCount?: number,
      behindCount?: number,
      modifiedFiles?: string[]
    }
  ]
}

// Task result
{
  type: 'task-result',
  taskId: string,
  result: unknown,
  status: 'completed' | 'failed',
  logs?: string
}

// Pong (response to ping)
{
  type: 'pong',
  timestamp?: number
}
```

### Outgoing (to Local Agent)

```typescript
// Task assignment
{
  type: 'task',
  taskId: string,
  taskType: string,
  payload: unknown
}

// Ping (health check)
{
  type: 'ping',
  timestamp: number
}

// Status request
{
  type: 'status-request'
}
```

## Authentication

WebSocket upgrade and API endpoints use API key authentication:

```
Authorization: Bearer <QUEUE_API_KEY or ASSISTANT_API_KEY>
```

## Usage

### WebSocket Connection (Local Agent)

```typescript
const ws = new WebSocket('wss://your-worker.workers.dev/api/ws', {
  headers: {
    'Authorization': 'Bearer YOUR_API_KEY'
  }
});

ws.onopen = () => {
  // Send agent status
  ws.send(JSON.stringify({
    type: 'agent-status',
    agentId: 'mac-agent-1',
    status: 'online',
    capabilities: ['git', 'npm', 'docker']
  }));
};

ws.onmessage = (event) => {
  const message = JSON.parse(event.data);

  if (message.type === 'task') {
    // Execute task
    executeTask(message.taskId, message.payload);
  } else if (message.type === 'ping') {
    // Respond to ping
    ws.send(JSON.stringify({ type: 'pong' }));
  }
};
```

### Create Task via API

```bash
curl -X POST https://your-worker.workers.dev/api/cockpit/tasks \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Run npm test",
    "executor": "subagent",
    "payload": { "command": "npm test" }
  }'
```

### List Tasks

```bash
curl "https://your-worker.workers.dev/api/cockpit/tasks?status=pending&limit=10" \
  -H "Authorization: Bearer YOUR_API_KEY"
```

### List Git Repositories

```bash
curl "https://your-worker.workers.dev/api/cockpit/repos?status=dirty" \
  -H "Authorization: Bearer YOUR_API_KEY"
```

### List Alerts

```bash
curl "https://your-worker.workers.dev/api/cockpit/alerts?severity=critical&acknowledged=false" \
  -H "Authorization: Bearer YOUR_API_KEY"
```

### Acknowledge Alert

```bash
curl -X POST "https://your-worker.workers.dev/api/cockpit/alerts/ack/alert_123" \
  -H "Authorization: Bearer YOUR_API_KEY"
```

## Deployment

### Apply D1 Migration

```bash
# Development
npx wrangler d1 execute knowledge-base --local --file=migrations/0005_cockpit_tables.sql

# Production
npx wrangler d1 execute knowledge-base --file=migrations/0005_cockpit_tables.sql
```

### Deploy Worker

```bash
# Development
npx wrangler deploy

# Production
npm run deploy:production
```

### Verify Bindings

```bash
npx wrangler deploy --dry-run
```

Should show:
- `COCKPIT_WS: CockpitWebSocket`
- `TASK_COORDINATOR: TaskCoordinator`
- `DB: knowledge-base`

## Monitoring

### Check Connected Agents

Internal DO endpoint (requires API key):
```bash
curl "http://do/agents" \
  -H "Authorization: Bearer YOUR_API_KEY"
```

Returns:
```json
{
  "agents": [
    {
      "agentId": "mac-agent-1",
      "connectedAt": "2024-01-28T10:00:00Z",
      "lastPingAt": "2024-01-28T10:05:00Z",
      "status": "online",
      "capabilities": ["git", "npm"]
    }
  ],
  "count": 1
}
```

### Alarm (Periodic Cleanup)

- Runs every 60 seconds
- Sends ping to all connected agents
- Cleans up stale connections (no pong for 2 minutes)

## Error Handling

### Message Validation

Invalid messages return error via WebSocket:
```json
{
  "type": "error",
  "message": "Invalid message format",
  "details": [/* Zod validation errors */]
}
```

### WebSocket Close Codes

- `1000`: Normal closure (stale connection detected)
- `1001`: Client going away
- `1002`: Protocol error
- `1011`: Internal server error

## Security

- API key authentication on upgrade and API requests
- Message validation with Zod schemas
- No Node.js APIs (Cloudflare Workers compatible)
- Sandboxed execution in Durable Objects
- Stale connection cleanup prevents resource leaks

## Future Enhancements

- [ ] Agent-specific task routing (by capabilities)
- [ ] Task priority queue
- [ ] Agent health metrics (CPU, memory, disk)
- [ ] Multi-agent task coordination
- [ ] Alert escalation to Discord/Slack
- [ ] Historical task analytics
