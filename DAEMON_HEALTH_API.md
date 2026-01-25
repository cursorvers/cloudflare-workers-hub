# Daemon Health Monitoring API

## Overview

New API endpoints for monitoring active daemons with heartbeat mechanism. This allows visibility into which daemons are active and their health status.

## Endpoints

### 1. POST /api/daemon/register

Register a new daemon with heartbeat tracking.

**Authentication**: Requires `ADMIN_API_KEY` in `X-API-Key` header

**Request**:
```json
{
  "daemonId": "daemon_macmini_1",
  "version": "2.2",
  "capabilities": ["queue", "cron"],
  "pollInterval": 5000,
  "registeredAt": "2026-01-25T12:00:00Z"
}
```

**Response** (201 Created):
```json
{
  "success": true,
  "daemonId": "daemon_macmini_1",
  "registeredAt": "2026-01-25T12:00:00Z"
}
```

### 2. POST /api/daemon/heartbeat

Update daemon heartbeat and status.

**Authentication**: Requires `ADMIN_API_KEY` in `X-API-Key` header

**Request**:
```json
{
  "daemonId": "daemon_macmini_1",
  "status": "healthy",
  "tasksProcessed": 42,
  "currentTask": "evt_123...",
  "lastHeartbeat": "2026-01-25T12:05:00Z"
}
```

**Response**:
```json
{
  "success": true
}
```

**Error Response** (404 Not Found):
```json
{
  "error": "Daemon not registered"
}
```

### 3. GET /api/daemon/health

List active daemons and detect stale daemons.

**Authentication**: Requires `ADMIN_API_KEY` in `X-API-Key` header

**Response**:
```json
{
  "activeDaemons": [
    {
      "daemonId": "daemon_macmini_1",
      "version": "2.2",
      "capabilities": ["queue", "cron"],
      "pollInterval": 5000,
      "registeredAt": "2026-01-25T12:00:00Z",
      "lastHeartbeat": "2026-01-25T12:05:30Z",
      "status": "healthy",
      "tasksProcessed": 42,
      "currentTask": "evt_123..."
    }
  ],
  "stale": [],
  "totalActive": 1
}
```

## Implementation Details

### KV Storage Schema

| Key | Value | TTL | Description |
|-----|-------|-----|-------------|
| `daemon:state:{daemonId}` | DaemonState JSON | 60s | Individual daemon state |
| `daemon:active` | string[] | 3600s | List of active daemon IDs |

### Stale Detection

Daemons are considered **stale** if:
- No heartbeat received for > 60 seconds
- KV entry expired

Stale daemons are automatically removed from the active list.

### Types

```typescript
interface DaemonRegistration {
  daemonId: string;
  version: string;
  capabilities: string[];
  pollInterval: number;
  registeredAt: string;
}

interface DaemonHeartbeat {
  daemonId: string;
  status: 'healthy' | 'degraded' | 'unhealthy';
  tasksProcessed: number;
  currentTask?: string;
  lastHeartbeat: string;
}

interface DaemonState extends DaemonRegistration {
  lastHeartbeat: string;
  status: 'healthy' | 'degraded' | 'unhealthy';
  tasksProcessed: number;
  currentTask?: string;
}
```

## Security

- All endpoints require `ADMIN_API_KEY` authentication
- Rate limiting applied (same as other admin endpoints)
- Constant-time API key comparison to prevent timing attacks
- Automatic cleanup of expired daemon states

## Integration with Daemon v2.2

### Daemon Startup Flow

```javascript
// 1. Register on startup
const registration = await fetch('https://workers-hub.example.com/api/daemon/register', {
  method: 'POST',
  headers: {
    'X-API-Key': process.env.ADMIN_API_KEY,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    daemonId: 'daemon_macmini_1',
    version: '2.2',
    capabilities: ['queue', 'cron'],
    pollInterval: 5000,
    registeredAt: new Date().toISOString(),
  }),
});

// 2. Send heartbeat every 30 seconds (TTL is 60s)
setInterval(async () => {
  await fetch('https://workers-hub.example.com/api/daemon/heartbeat', {
    method: 'POST',
    headers: {
      'X-API-Key': process.env.ADMIN_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      daemonId: 'daemon_macmini_1',
      status: getHealthStatus(), // 'healthy' | 'degraded' | 'unhealthy'
      tasksProcessed: taskCounter,
      currentTask: currentTaskId,
      lastHeartbeat: new Date().toISOString(),
    }),
  });
}, 30000);
```

### Monitoring Dashboard Flow

```javascript
// Check daemon health
const health = await fetch('https://workers-hub.example.com/api/daemon/health', {
  headers: {
    'X-API-Key': process.env.ADMIN_API_KEY,
  },
});

const { activeDaemons, stale, totalActive } = await health.json();

// Alert if no active daemons
if (totalActive === 0) {
  sendAlert('No active daemons detected!');
}

// Alert on stale daemons
if (stale.length > 0) {
  sendAlert(`Stale daemons: ${stale.map(d => d.daemonId).join(', ')}`);
}
```

## Files Modified

1. **src/handlers/daemon.ts** (NEW)
   - `registerDaemon()` - Register new daemon
   - `updateHeartbeat()` - Update heartbeat
   - `getDaemonHealth()` - Get health status

2. **src/index.ts**
   - Added `handleDaemonAPI()` function
   - Added routing for `/api/daemon/*` endpoints
   - Imported daemon handler functions

## Testing

### Manual Testing

```bash
# Set ADMIN_API_KEY
export ADMIN_API_KEY="your-admin-key"

# Register daemon
curl -X POST https://workers-hub.example.com/api/daemon/register \
  -H "X-API-Key: $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "daemonId": "daemon_test_1",
    "version": "2.2",
    "capabilities": ["queue"],
    "pollInterval": 5000,
    "registeredAt": "'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"
  }'

# Send heartbeat
curl -X POST https://workers-hub.example.com/api/daemon/heartbeat \
  -H "X-API-Key: $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "daemonId": "daemon_test_1",
    "status": "healthy",
    "tasksProcessed": 10,
    "lastHeartbeat": "'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"
  }'

# Check health
curl https://workers-hub.example.com/api/daemon/health \
  -H "X-API-Key: $ADMIN_API_KEY"
```

## Deployment

```bash
# Deploy to Cloudflare Workers
wrangler deploy
```

Ensure `ADMIN_API_KEY` is set in Cloudflare Workers environment variables.

## Future Enhancements

- [ ] Daemon metrics aggregation (avg response time, error rate)
- [ ] Webhook notifications on daemon failure
- [ ] Historical daemon uptime tracking
- [ ] Multi-region daemon coordination
