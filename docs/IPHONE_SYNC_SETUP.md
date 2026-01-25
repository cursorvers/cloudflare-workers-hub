# iPhone-Triggered Limitless Sync Setup

## Overview

This document describes the hybrid sync system for Limitless.ai Pendant recordings using iPhone as the primary trigger with server-side cron as a backup.

### System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Hybrid Sync System                       │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Primary: iPhone Trigger (real-time)                       │
│  ├── Limitless notification received                       │
│  ├── iOS Shortcuts automation triggered                    │
│  └── HTTP POST to /api/limitless/webhook-sync              │
│                                                             │
│  Backup: Server Cron (daily at 2 AM)                       │
│  ├── Catches items missed by iPhone triggers               │
│  ├── Runs scheduled sync for last 26 hours                 │
│  └── Logs items that were already synced                   │
│                                                             │
│  Deduplication                                              │
│  ├── KV store tracks last sync time per user               │
│  ├── Minimum 10-minute gap between syncs                   │
│  └── Knowledge service may have additional dedup           │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## Prerequisites

1. **Limitless.ai Account**
   - Active Pendant device
   - API key from Limitless.ai dashboard

2. **Cloudflare Workers Hub Deployment**
   - Workers Hub deployed and accessible
   - Environment variables configured (see below)

3. **iPhone with iOS 16+**
   - iOS Shortcuts app installed
   - Reliable internet connection

## Environment Variables

Add these to your Cloudflare Workers environment:

```bash
# Limitless API Configuration
LIMITLESS_API_KEY=your_limitless_api_key_here
LIMITLESS_USER_ID=your_user_id
LIMITLESS_AUTO_SYNC_ENABLED=true

# Backup sync interval (default: 24 hours)
LIMITLESS_SYNC_INTERVAL_HOURS=24

# Optional: Authentication for webhook
MONITORING_API_KEY=your_secure_api_key_here
```

To set via Wrangler:

```bash
# Required
wrangler secret put LIMITLESS_API_KEY
wrangler secret put LIMITLESS_USER_ID

# Optional (recommended)
wrangler secret put MONITORING_API_KEY
```

## API Endpoint

### POST /api/limitless/webhook-sync

**Purpose:** Trigger Limitless sync from iPhone

**Authentication:**
- Optional: Bearer token in `Authorization` header
- Without auth: 10 requests/minute rate limit (IP-based)
- With auth: 60 requests/minute rate limit (user-based)

**Request Body:**

```json
{
  "userId": "your-user-id",
  "triggerSource": "ios_shortcut",
  "maxAgeHours": 1,
  "includeAudio": false
}
```

**Minimal Request:**

```json
{
  "userId": "your-user-id"
}
```

**Response (Success):**

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

**Response (Skipped - Too Recent):**

```json
{
  "success": true,
  "skipped": true,
  "reason": "Recent sync already completed",
  "lastSync": "2026-01-25T10:15:00Z",
  "nextAllowedSync": "2026-01-25T10:25:00Z"
}
```

**Response (Rate Limited):**

```json
{
  "error": "Too Many Requests",
  "retryAfter": 45,
  "resetAt": "2026-01-25T10:16:00Z"
}
```

## iOS Shortcuts Setup

### Option 1: Simple Shortcut (No Authentication)

**Step 1:** Create a new Shortcut

1. Open **Shortcuts** app
2. Tap **+** to create new shortcut
3. Name it "Sync Limitless"

**Step 2:** Add actions

1. **Get Contents of URL**
   - URL: `https://your-workers-hub.workers.dev/api/limitless/webhook-sync`
   - Method: `POST`
   - Headers: `Content-Type: application/json`
   - Request Body:
     ```json
     {
       "userId": "YOUR_USER_ID_HERE"
     }
     ```

2. **Show Notification** (Optional - for debugging)
   - Title: "Limitless Sync"
   - Body: "Contents of URL"

**Step 3:** Test the shortcut

1. Tap the shortcut to run it
2. Check response for success

### Option 2: Authenticated Shortcut (Recommended)

**Step 1:** Create a new Shortcut

Same as Option 1

**Step 2:** Add actions with authentication

1. **Get Contents of URL**
   - URL: `https://your-workers-hub.workers.dev/api/limitless/webhook-sync`
   - Method: `POST`
   - Headers:
     - `Content-Type: application/json`
     - `Authorization: Bearer YOUR_MONITORING_API_KEY`
   - Request Body:
     ```json
     {
       "userId": "YOUR_USER_ID_HERE"
     }
     ```

2. **Get Dictionary from Input**
   - Input: "Contents of URL"

3. **If** (for error handling)
   - Condition: "Dictionary has key 'success'"
   - If True:
     - **Show Notification**
       - Title: "Sync Success"
       - Body: "Synced: [Get value for 'result.synced' in Dictionary]"
   - If False:
     - **Show Notification**
       - Title: "Sync Failed"
       - Body: "Contents of URL"

### Option 3: Advanced with Custom Trigger

**Step 1:** Create Personal Automation

1. Open **Shortcuts** app → **Automation** tab
2. Tap **+** → **Create Personal Automation**
3. Choose trigger:
   - **Time of Day** (e.g., every 4 hours)
   - **When I arrive** (at home/office)
   - **When I leave** (a location)
   - **When I connect to** (specific Wi-Fi)

**Step 2:** Add the shortcut action

1. **Run Shortcut**
   - Select: "Sync Limitless" (from Option 2)
2. Turn off "Ask Before Running" (for automatic execution)

## Detecting New Recordings on iPhone

Since Limitless doesn't provide direct push notifications to third-party apps, you can use these methods:

### Method 1: Scheduled Automation (Recommended)

Run the shortcut automatically at regular intervals:

- **Every 4 hours** during waking hours (8 AM - 10 PM)
- **When connecting to home Wi-Fi** (end of day sync)
- **When connecting to car Bluetooth** (after commute)

**Automation Setup:**

1. Shortcuts → Automation → Create Personal Automation
2. **Time of Day**
   - Time: 8:00 AM
   - Repeat: Custom → Every 4 hours
   - End Repeat: 10:00 PM
3. Add Action → Run Shortcut → "Sync Limitless"
4. Turn off "Ask Before Running"

### Method 2: Manual Trigger via Widget

Add shortcut to Home Screen:

1. Long press on shortcut → **Add to Home Screen**
2. Tap icon when you want to sync

### Method 3: Location-Based

Trigger sync when arriving home/office:

1. Automation → Create Personal Automation
2. **Arrive** → Select location (Home/Office)
3. Add Action → Run Shortcut → "Sync Limitless"

### Method 4: Siri Voice Command

1. Shortcuts → Select "Sync Limitless"
2. Settings → Add to Siri
3. Record phrase: "Sync my notes"

Then say "Hey Siri, sync my notes"

## Backup Cron Sync

The server runs a backup sync daily at 2 AM (configurable in `wrangler.toml`).

**Purpose:**
- Catch recordings missed by iPhone triggers
- Ensure no data loss if iPhone is offline
- Provide redundancy

**Configuration:**

In `wrangler.toml`:

```toml
[triggers]
crons = ["0 2 * * *"]  # Daily at 2 AM
```

Change to different schedule:

```toml
# Every 6 hours
crons = ["0 */6 * * *"]

# Twice daily (2 AM and 2 PM)
crons = ["0 2,14 * * *"]

# Every hour (not recommended - use iPhone trigger instead)
crons = ["0 * * * *"]
```

**Environment Variables:**

```bash
# Enable backup sync
LIMITLESS_AUTO_SYNC_ENABLED=true

# Backup sync interval (hours)
LIMITLESS_SYNC_INTERVAL_HOURS=24

# User ID to sync
LIMITLESS_USER_ID=your_user_id
```

**Viewing Backup Sync Logs:**

```bash
# Via Wrangler
wrangler tail

# In logs, look for:
# [Scheduled] Starting Limitless backup sync
# [Scheduled] Limitless backup sync completed
```

**Example Log Output:**

```
[Scheduled] Starting Limitless backup sync
  userId: user-***
  syncIntervalHours: 24
  purpose: catch-up backup (primary sync via iPhone webhook)

[Scheduled] Limitless backup sync completed
  userId: user-***
  synced: 0
  skipped: 5
  errors: 0
  durationMs: 1523
  note: No new items
```

If `synced > 0`, the backup caught items that iPhone missed.

## Deduplication Strategy

The system prevents duplicate syncs using multiple layers:

### Layer 1: Request-Level Deduplication (10-minute window)

```typescript
// In limitless-webhook.ts
async function checkShouldSync(userId: string, maxAgeHours: number) {
  // For 1-hour syncs (iPhone), require 10-minute gap
  // For longer syncs, require proportional gap
  const minIntervalMinutes = Math.max(10, maxAgeHours * 5);

  // Check last sync timestamp from KV
  // If last sync was < 10 minutes ago, skip
}
```

**Example:**
```
10:00 AM - iPhone trigger → syncs last 1 hour
10:05 AM - iPhone trigger → skipped (too recent)
10:12 AM - iPhone trigger → allowed (>10 min gap)
```

### Layer 2: Knowledge Service Deduplication

The `syncToKnowledge` function in `limitless.ts`:

```typescript
// Skips lifelogs without transcript or summary
if (!lifelog.transcript && !lifelog.summary) {
  skipped++;
  continue;
}
```

If the knowledge service uses lifelog IDs, it will automatically skip duplicates.

### Layer 3: Backup Sync Deduplication

The daily cron:
- Uses a separate KV key (`limitless:backup_sync:${userId}`)
- Only runs if 24 hours have passed
- Syncs last 26 hours (overlaps with iPhone triggers)
- Knowledge service handles duplicate detection

**Result:** Even if iPhone syncs every hour and backup runs daily, no duplicates are created.

## Rate Limiting

### Without Authentication

- **10 requests per minute** per IP address
- Suitable for personal use
- May be blocked if sharing IP (corporate network)

### With Authentication

- **60 requests per minute** per user
- Recommended for automated triggers
- More reliable

**Rate Limit Headers in Response:**

```
X-RateLimit-Remaining: 58
X-RateLimit-Reset: 1706182560
Retry-After: 15  (only if rate limited)
```

## Monitoring & Debugging

### Check Last Sync Status

**Via API:**

```bash
# Get webhook stats
curl -H "Authorization: Bearer YOUR_API_KEY" \
  https://your-workers-hub.workers.dev/api/limitless/config
```

**Via Wrangler KV:**

```bash
# List all Limitless keys
wrangler kv:key list --binding=CACHE --prefix="limitless:"

# Get last webhook sync time
wrangler kv:key get --binding=CACHE "limitless:webhook_last_sync:YOUR_USER_ID"

# Get webhook stats
wrangler kv:key get --binding=CACHE "limitless:webhook_stats:YOUR_USER_ID"
```

**Sample Stats:**

```json
{
  "lastSync": "2026-01-25T10:15:30Z",
  "triggerSource": "ios_shortcut",
  "totalSyncs": 42
}
```

### View Logs

**Real-time via Wrangler:**

```bash
wrangler tail
```

**Filter for Limitless events:**

```bash
wrangler tail | grep "Limitless"
```

**Sample Log Output:**

```
[Limitless Webhook] Sync triggered
  userId: user-***
  triggerSource: ios_shortcut
  maxAgeHours: 1
  hasAuth: true

[Limitless Webhook] Sync completed
  userId: user-***
  synced: 2
  skipped: 0
  errors: 0
  durationMs: 1234
```

### Common Issues & Solutions

**Issue: "Rate limit exceeded"**

Solution:
- Add `Authorization` header with `MONITORING_API_KEY`
- Reduce sync frequency in iOS automation
- Check if multiple shortcuts are triggering

**Issue: "Recent sync already completed"**

Solution:
- This is expected behavior (10-minute dedup window)
- No action needed - system is working correctly
- Adjust `maxAgeHours` if needed

**Issue: "Limitless integration not configured"**

Solution:
```bash
wrangler secret put LIMITLESS_API_KEY
```

**Issue: No recordings synced (synced: 0)**

Possible causes:
1. No new recordings in the time window
2. Recordings have no transcript/summary (skipped)
3. Time zone mismatch

Check:
```bash
# Verify API key works
curl -H "X-API-Key: YOUR_LIMITLESS_KEY" \
  https://api.limitless.ai/v1/lifelogs?limit=5
```

**Issue: Shortcut fails with "Invalid JSON"**

Solution:
- Check Request Body format in shortcut
- Ensure `userId` is a string (use quotes)
- Remove any trailing commas

**Correct format:**
```json
{
  "userId": "your-user-id"
}
```

**Incorrect format:**
```json
{
  userId: your-user-id,  ❌ Missing quotes, trailing comma
}
```

## Security Considerations

### API Key Protection

**Never hardcode API keys in shortcuts that are shared!**

Options:
1. Use environment variables (not possible in iOS Shortcuts)
2. Store in iCloud Keychain (not directly accessible)
3. Accept the risk for personal use only

**Recommendation:** Use the webhook without authentication for personal shortcuts, rely on rate limiting for protection.

### Rate Limit Bypass

If you need higher limits:

```bash
# Increase authenticated rate limit in rate-limiter.ts
limitless_webhook_auth: { windowMs: 60000, maxRequests: 120 }
```

### IP Allowlist (Advanced)

For extra security, add IP filtering in `limitless-webhook.ts`:

```typescript
const ALLOWED_IPS = ['YOUR_HOME_IP', 'YOUR_OFFICE_IP'];

function checkIPAllowed(request: Request): boolean {
  const ip = request.headers.get('CF-Connecting-IP');
  return ALLOWED_IPS.includes(ip);
}
```

## Advanced: Custom Sync Logic

You can customize sync behavior by modifying `limitless-webhook.ts`:

### Example: Sync Only Work Hours

```typescript
// In handleLimitlessWebhook
const now = new Date();
const hour = now.getHours();

if (hour < 9 || hour > 17) {
  return new Response(JSON.stringify({
    success: true,
    skipped: true,
    reason: 'Outside work hours',
  }), { status: 200 });
}
```

### Example: Conditional Audio Download

```typescript
// In request body
{
  "userId": "your-user-id",
  "maxAgeHours": 1,
  "includeAudio": true  // Download audio for important recordings
}
```

Audio is stored in R2 bucket `AUDIO_STAGING` at path:
```
limitless/{userId}/{lifelogId}.ogg
```

## Testing

### Manual Test via curl

**Without authentication:**

```bash
curl -X POST https://your-workers-hub.workers.dev/api/limitless/webhook-sync \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "test-user-123"
  }'
```

**With authentication:**

```bash
curl -X POST https://your-workers-hub.workers.dev/api/limitless/webhook-sync \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_MONITORING_API_KEY" \
  -d '{
    "userId": "your-user-id",
    "triggerSource": "manual",
    "maxAgeHours": 2
  }'
```

**Expected response:**

```json
{
  "success": true,
  "result": {
    "synced": 3,
    "skipped": 1,
    "errors": 0,
    "durationMs": 1523
  },
  "message": "Successfully synced 3 recording(s)"
}
```

### Test Rate Limiting

```bash
# Send 15 requests in a row (should hit 10/min limit)
for i in {1..15}; do
  curl -X POST https://your-workers-hub.workers.dev/api/limitless/webhook-sync \
    -H "Content-Type: application/json" \
    -d '{"userId":"test"}' \
    -w "\nStatus: %{http_code}\n"
  sleep 1
done
```

Expected: First 10 succeed (200), remaining fail (429).

### Test Deduplication

```bash
# First request
curl -X POST ... -d '{"userId":"test"}'
# Response: synced: 2

# Immediate second request (< 10 min)
curl -X POST ... -d '{"userId":"test"}'
# Response: skipped: true, reason: "Recent sync already completed"
```

## Migration from Hourly Cron

If you previously used hourly cron (old setup):

**Step 1:** Update `wrangler.toml`

```diff
[triggers]
-crons = ["0 * * * *"]  # Every hour
+crons = ["0 2 * * *"]  # Daily at 2 AM
```

**Step 2:** Update environment variable

```bash
wrangler secret put LIMITLESS_SYNC_INTERVAL_HOURS
# Enter: 24
```

**Step 3:** Set up iPhone shortcut (see above)

**Step 4:** Deploy

```bash
wrangler deploy
```

**Result:**
- iPhone triggers sync in real-time (every 1-4 hours)
- Backup cron catches anything missed (once daily)
- Total API calls reduced by ~80%

## Cost Optimization

### Current System (Hourly Cron)

- 24 cron triggers/day
- ~10 API calls per trigger (pagination)
- **Total: ~240 Limitless API calls/day**

### New System (iPhone + Daily Backup)

- 6 iPhone triggers/day (every 4 hours)
- 1 backup cron/day
- ~10 API calls per trigger
- **Total: ~70 Limitless API calls/day**

**Savings: 70% reduction in API calls**

### Further Optimization

**Reduce backup frequency:**

```toml
# Weekly backup instead of daily
crons = ["0 2 * * 0"]  # Sundays at 2 AM
```

**Reduce iPhone trigger frequency:**

Only trigger on location changes (home/office) instead of time-based.

## Troubleshooting Checklist

- [ ] `LIMITLESS_API_KEY` is set in Wrangler secrets
- [ ] `LIMITLESS_USER_ID` matches your Limitless account
- [ ] `LIMITLESS_AUTO_SYNC_ENABLED=true` in environment
- [ ] iPhone has internet connectivity
- [ ] iOS Shortcuts app has network permissions
- [ ] Shortcut has correct endpoint URL
- [ ] Request body is valid JSON
- [ ] (Optional) `MONITORING_API_KEY` matches in shortcut and Wrangler
- [ ] Rate limit not exceeded (check response headers)
- [ ] Last sync was > 10 minutes ago (or adjust `maxAgeHours`)

## Support

For issues or questions:

1. Check logs: `wrangler tail`
2. Verify environment variables: `wrangler secret list`
3. Test endpoint with curl (see Testing section)
4. Review Limitless API status: https://status.limitless.ai

## References

- [Limitless API Documentation](https://docs.limitless.ai)
- [iOS Shortcuts User Guide](https://support.apple.com/guide/shortcuts/welcome/ios)
- [Cloudflare Workers Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [Cloudflare Workers KV](https://developers.cloudflare.com/kv/)
