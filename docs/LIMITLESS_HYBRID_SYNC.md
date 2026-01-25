# Limitless Hybrid Sync System

## Quick Overview

A two-tier sync system for Limitless.ai Pendant recordings:

1. **Primary: iPhone-triggered** (real-time, user-initiated)
2. **Backup: Server cron** (daily at 2 AM, catches missed items)

## Key Features

✅ **Real-time sync** via iPhone Shortcuts automation
✅ **Automatic backup** via daily cron (safety net)
✅ **Deduplication** prevents syncing the same items twice
✅ **Rate limiting** prevents abuse (10/min public, 60/min authenticated)
✅ **No missed recordings** - backup catches anything iPhone missed
✅ **70% reduction** in API calls vs hourly cron

## Quick Start

### 1. Configure Environment

```bash
wrangler secret put LIMITLESS_API_KEY
wrangler secret put LIMITLESS_USER_ID
wrangler secret put MONITORING_API_KEY  # Optional but recommended
```

### 2. Set Up iPhone Shortcut

**Create a new shortcut:**

1. Open Shortcuts app
2. Create new shortcut: "Sync Limitless"
3. Add action: **Get Contents of URL**
   - URL: `https://your-workers-hub.workers.dev/api/limitless/webhook-sync`
   - Method: POST
   - Headers:
     - `Content-Type: application/json`
     - `Authorization: Bearer YOUR_MONITORING_API_KEY` (optional)
   - Body:
     ```json
     {
       "userId": "YOUR_USER_ID"
     }
     ```

### 3. Automate the Shortcut

**Option A: Time-based** (recommended)

- Automation → Time of Day
- Every 4 hours (8 AM, 12 PM, 4 PM, 8 PM)
- Run Shortcut → "Sync Limitless"
- Turn off "Ask Before Running"

**Option B: Location-based**

- Automation → Arrive at Home/Office
- Run Shortcut → "Sync Limitless"

**Option C: Manual**

- Add shortcut to Home Screen
- Tap when you want to sync

### 4. Deploy Workers Hub

```bash
wrangler deploy
```

Done! iPhone will sync in real-time, and the server will catch anything missed at 2 AM daily.

## API Endpoint

### POST /api/limitless/webhook-sync

**Minimal request:**
```json
{
  "userId": "your-user-id"
}
```

**Full request:**
```json
{
  "userId": "your-user-id",
  "triggerSource": "ios_shortcut",
  "maxAgeHours": 1,
  "includeAudio": false
}
```

**Success response:**
```json
{
  "success": true,
  "result": {
    "synced": 3,
    "skipped": 1,
    "errors": 0,
    "durationMs": 1234
  },
  "message": "Successfully synced 3 recording(s)"
}
```

**Rate limit response:**
```json
{
  "error": "Too Many Requests",
  "retryAfter": 45,
  "resetAt": "2026-01-25T10:16:00Z"
}
```

## Deduplication

**3-layer system:**

1. **Request-level** (10-minute window) - Prevents duplicate webhook calls
2. **Knowledge service** - Skips lifelogs without content
3. **Backup sync** - Uses separate tracking, knowledge service handles duplicates

**Result:** No matter how many times you trigger sync, no duplicates are created.

## Rate Limits

| Authentication | Limit | Use Case |
|---------------|-------|----------|
| None | 10 req/min per IP | Personal use |
| Bearer token | 60 req/min per user | Automated triggers |

## Backup Cron Schedule

Default: Daily at 2 AM

To change in `wrangler.toml`:

```toml
[triggers]
# Every 6 hours
crons = ["0 */6 * * *"]

# Twice daily
crons = ["0 2,14 * * *"]

# Weekly (Sundays)
crons = ["0 2 * * 0"]
```

## Monitoring

**View logs:**
```bash
wrangler tail | grep "Limitless"
```

**Check stats:**
```bash
wrangler kv:key get --binding=CACHE "limitless:webhook_stats:YOUR_USER_ID"
```

**Sample output:**
```json
{
  "lastSync": "2026-01-25T10:15:30Z",
  "triggerSource": "ios_shortcut",
  "totalSyncs": 42
}
```

## Troubleshooting

**"Rate limit exceeded"**
→ Add `Authorization` header with `MONITORING_API_KEY`

**"Recent sync already completed"**
→ Expected behavior (10-minute dedup window)

**"Limitless integration not configured"**
→ Run: `wrangler secret put LIMITLESS_API_KEY`

**No recordings synced (synced: 0)**
→ Check if recordings have transcript/summary (empty recordings are skipped)

## Cost Comparison

| System | API Calls/Day | Savings |
|--------|--------------|---------|
| Old (hourly cron) | ~240 | - |
| New (iPhone + daily backup) | ~70 | 70% |
| Optimized (iPhone + weekly backup) | ~60 | 75% |

## Full Documentation

See [IPHONE_SYNC_SETUP.md](./IPHONE_SYNC_SETUP.md) for:
- Detailed setup instructions
- iOS Shortcuts recipes
- Security considerations
- Advanced customization
- Testing procedures

## Architecture Diagram

```
┌──────────────────────────────────────────────────────┐
│                  User's iPhone                       │
│  ┌────────────────────────────────────────────┐     │
│  │  Limitless notification received           │     │
│  └──────────────┬─────────────────────────────┘     │
│                 ↓                                    │
│  ┌────────────────────────────────────────────┐     │
│  │  iOS Shortcuts Automation                  │     │
│  │  - Triggered by time/location/manual       │     │
│  └──────────────┬─────────────────────────────┘     │
└─────────────────┼──────────────────────────────────┘
                  ↓ HTTP POST
┌─────────────────▼──────────────────────────────────┐
│         Cloudflare Workers Hub                     │
│  ┌──────────────────────────────────────────┐     │
│  │  POST /api/limitless/webhook-sync        │     │
│  │  - Rate limiting (10/min or 60/min)      │     │
│  │  - Deduplication check (10-min window)   │     │
│  └──────────────┬───────────────────────────┘     │
│                 ↓                                  │
│  ┌──────────────────────────────────────────┐     │
│  │  syncToKnowledge()                       │     │
│  │  - Fetch lifelogs from Limitless API     │     │
│  │  - Store in D1 knowledge base             │     │
│  │  - Optional: Store audio in R2           │     │
│  └──────────────┬───────────────────────────┘     │
│                 ↓                                  │
│  ┌──────────────────────────────────────────┐     │
│  │  Update KV state                         │     │
│  │  - Last sync timestamp                   │     │
│  │  - Sync stats (total syncs, etc.)        │     │
│  └──────────────────────────────────────────┘     │
└────────────────────────────────────────────────────┘

              Backup (Daily at 2 AM)
                       ↓
┌────────────────────────────────────────────────────┐
│         Scheduled Cron Handler                     │
│  - Syncs last 26 hours (catches missed items)     │
│  - Separate KV key (backup_sync)                  │
│  - Knowledge service handles duplicate detection  │
└────────────────────────────────────────────────────┘
```

## Next Steps

1. **Test the endpoint** with curl
2. **Set up iPhone shortcut** following the guide
3. **Run a test sync** manually
4. **Enable automation** for hands-free operation
5. **Monitor logs** for the first few days
6. **Optimize schedule** based on your recording patterns

For questions or issues, see the full documentation or check logs with `wrangler tail`.
