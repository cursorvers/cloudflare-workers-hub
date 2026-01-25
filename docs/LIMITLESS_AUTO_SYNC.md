# Limitless.ai Auto-Sync

Automatic synchronization of Limitless.ai Pendant voice recordings to the knowledge service using Cloudflare Workers Cron Triggers.

## Features

- ✅ Automatic hourly sync of Limitless.ai lifelogs
- ✅ Configurable sync interval
- ✅ Stores sync state in KV
- ✅ Prevents duplicate syncs
- ✅ Detailed logging for debugging
- ✅ Error handling with retry logic

## Configuration

### Environment Variables

Add the following environment variables to your Cloudflare Workers:

```bash
# Required
LIMITLESS_API_KEY=your-limitless-api-key
LIMITLESS_USER_ID=your-user-id

# Optional
LIMITLESS_AUTO_SYNC_ENABLED=true  # Enable auto-sync (default: false)
LIMITLESS_SYNC_INTERVAL_HOURS=1   # Sync interval (default: 1 hour)
```

### wrangler.toml

The cron trigger is already configured in `wrangler.toml`:

```toml
[triggers]
crons = ["0 * * * *"]  # Every hour
```

You can customize the cron schedule:

| Cron Expression | Description |
|-----------------|-------------|
| `0 * * * *` | Every hour at :00 |
| `*/30 * * * *` | Every 30 minutes |
| `0 */2 * * *` | Every 2 hours |
| `0 0 * * *` | Daily at midnight |
| `0 9,17 * * *` | At 9 AM and 5 PM |

[Cron syntax reference](https://developers.cloudflare.com/workers/configuration/cron-triggers/)

## How It Works

### Sync Flow

```
Cron Trigger (hourly)
    ↓
Check if auto-sync enabled
    ↓
Check if LIMITLESS_API_KEY configured
    ↓
Get last sync time from KV
    ↓
If (hours since last sync) >= interval → sync
    ↓
Fetch lifelogs from Limitless API
    ↓
Store in knowledge service
    ↓
Update last sync time in KV
    ↓
Update sync stats in KV
```

### KV Storage

**Last Sync Time**:
- Key: `limitless:last_sync:{userId}`
- Value: ISO timestamp (e.g., `2024-01-25T12:00:00.000Z`)

**Sync Stats**:
- Key: `limitless:sync_stats:{userId}`
- Value: JSON object
  ```json
  {
    "lastSync": "2024-01-25T12:00:00.000Z",
    "synced": 5,
    "skipped": 2,
    "errors": 0,
    "durationMs": 1234
  }
  ```

## Manual Testing

### Using wrangler CLI

Test the cron handler locally:

```bash
# Trigger scheduled event locally
curl "http://localhost:8787/__scheduled?cron=0+*+*+*+*"
```

### Using API endpoint

Alternatively, use the manual sync endpoint:

```bash
# Manual sync
curl -X GET "https://your-worker.workers.dev/api/limitless/sync?userId=YOUR_USER_ID" \
  -H "Authorization: Bearer YOUR_MONITORING_API_KEY"
```

## Monitoring

### Check Sync Stats

```bash
# Get sync stats from KV
wrangler kv:key get --binding=CACHE "limitless:sync_stats:YOUR_USER_ID"
```

### View Logs

```bash
# Tail live logs
wrangler tail

# Filter for Limitless events
wrangler tail --format json | grep -i limitless
```

### Health Check

```bash
# Check if auto-sync is configured
curl "https://your-worker.workers.dev/api/limitless/config" \
  -H "Authorization: Bearer YOUR_MONITORING_API_KEY"

# Response:
# {
#   "configured": true,
#   "defaultMaxAgeHours": 24,
#   "defaultIncludeAudio": false
# }
```

## Deployment

### 1. Set Environment Variables

Using Wrangler:

```bash
# Set secrets (sensitive values)
wrangler secret put LIMITLESS_API_KEY
wrangler secret put LIMITLESS_USER_ID

# Set regular variables
wrangler secret put LIMITLESS_AUTO_SYNC_ENABLED
# Enter: true

wrangler secret put LIMITLESS_SYNC_INTERVAL_HOURS
# Enter: 1
```

Using Cloudflare Dashboard:
1. Go to Workers & Pages → Your Worker → Settings → Variables
2. Add the environment variables
3. Save and redeploy

### 2. Deploy Worker

```bash
# Deploy to production
wrangler deploy

# Check cron triggers
wrangler deployments list
```

### 3. Verify Cron Schedule

```bash
# View cron schedules
wrangler deployments list

# Should show:
# Cron Triggers: 0 * * * * (every hour)
```

## Troubleshooting

### Auto-sync not running

Check:
1. ✅ `LIMITLESS_AUTO_SYNC_ENABLED=true` is set
2. ✅ `LIMITLESS_API_KEY` is configured
3. ✅ `LIMITLESS_USER_ID` is configured
4. ✅ Cron trigger is deployed

View logs:
```bash
wrangler tail | grep "Scheduled"
```

### Sync errors

Common issues:

| Error | Cause | Solution |
|-------|-------|----------|
| `LIMITLESS_API_KEY not configured` | Missing API key | Set `LIMITLESS_API_KEY` secret |
| `LIMITLESS_USER_ID not configured` | Missing user ID | Set `LIMITLESS_USER_ID` secret |
| `HTTP 401` | Invalid API key | Check API key validity |
| `HTTP 429` | Rate limit exceeded | Increase sync interval |

### Manual override

Force a sync regardless of interval:

```bash
# Delete last sync time
wrangler kv:key delete --binding=CACHE "limitless:last_sync:YOUR_USER_ID"

# Wait for next cron trigger (or trigger manually)
curl "http://localhost:8787/__scheduled?cron=0+*+*+*+*"
```

## Performance

### Resource Usage

| Metric | Typical Value |
|--------|---------------|
| CPU time | 50-200ms |
| Requests | 2-10 (depending on pagination) |
| KV reads | 1 |
| KV writes | 2 |
| Bandwidth | ~10KB per lifelog |

### Rate Limits

- Limitless API: 100 requests/minute
- Cloudflare Workers: 1000 requests/second (free plan)

**Recommendation**: Keep sync interval ≥ 1 hour to avoid rate limits.

## Advanced Usage

### Custom Sync Interval

Set different intervals for different environments:

**Development**:
```bash
wrangler secret put LIMITLESS_SYNC_INTERVAL_HOURS --env development
# Enter: 4  # Every 4 hours
```

**Production**:
```bash
wrangler secret put LIMITLESS_SYNC_INTERVAL_HOURS --env production
# Enter: 1  # Every hour
```

### Disable Auto-Sync

Temporarily disable without removing configuration:

```bash
wrangler secret put LIMITLESS_AUTO_SYNC_ENABLED
# Enter: false
```

### Multiple Users

Currently supports single user. For multiple users:

1. Store user list in KV
2. Iterate through users in scheduled handler
3. Sync each user's lifelogs

Future enhancement: Add `LIMITLESS_USER_IDS` (comma-separated list).

## Security

### API Key Protection

- ✅ API keys stored as Wrangler secrets (encrypted)
- ✅ Never logged (sanitized by `log-sanitizer`)
- ✅ Not included in error messages

### Rate Limiting

- Manual sync endpoint is rate-limited
- Auto-sync respects sync interval

### Access Control

- Manual sync requires `MONITORING_API_KEY`
- Config endpoint requires `MONITORING_API_KEY` or `ADMIN_API_KEY`

## Related Documentation

- [Limitless API Integration](./LIMITLESS_API.md)
- [Cloudflare Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [KV Storage](https://developers.cloudflare.com/workers/runtime-apis/kv/)
