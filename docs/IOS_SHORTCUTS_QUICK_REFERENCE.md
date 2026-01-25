# iOS Shortcuts Quick Reference Card

## 5-Minute Setup

### 1. Get Your Credentials

From your server admin:
- **Endpoint URL:** `https://your-workers-hub.workers.dev/api/limitless/webhook-sync`
- **User ID:** (your unique user ID)
- **API Key:** (optional, for authentication)

### 2. Create Shortcut

Open **Shortcuts** app → **Create New Shortcut**

**Name:** Sync Limitless

### 3. Add Action: Get Contents of URL

Tap **Add Action** → Search for "Get Contents of URL"

**Configure:**

| Field | Value |
|-------|-------|
| URL | `https://your-workers-hub.workers.dev/api/limitless/webhook-sync` |
| Method | **POST** |
| Headers | Tap "Headers" → Add items below |
| Request Body | **JSON** (see below) |

**Headers:**
```
Content-Type: application/json
Authorization: Bearer YOUR_API_KEY_HERE (optional)
```

**Request Body (JSON):**
```json
{
  "userId": "YOUR_USER_ID_HERE"
}
```

**Visual:**
```
┌───────────────────────────────────┐
│ Get Contents of                   │
│ https://your-workers-hub...       │
│                                   │
│ Method: POST                      │
│ ▼ Headers                         │
│   Content-Type: application/json  │
│   Authorization: Bearer ...       │
│                                   │
│ Request Body: JSON                │
│ {                                 │
│   "userId": "your-user-id"        │
│ }                                 │
└───────────────────────────────────┘
```

### 4. Add Notification (Optional - for confirmation)

Tap **+** → Search for "Show Notification"

**Configure:**
```
Title: Limitless Sync
Body: Contents of URL
```

### 5. Test It

Tap **▶ Run** → Should see success message

### 6. Automate It

**Shortcuts** → **Automation** → **Create Personal Automation**

**Choose Trigger:**

| Trigger | When | Good For |
|---------|------|----------|
| **Time of Day** | Every 4 hours (8 AM, 12 PM, 4 PM, 8 PM) | Regular sync |
| **Arrive** | Home/Office | End-of-day sync |
| **Leave** | Home/Office | After commute |
| **Connect to Wi-Fi** | Specific network | Home/office arrival |

**Then:**
1. Add Action → **Run Shortcut**
2. Select: "Sync Limitless"
3. **Turn off "Ask Before Running"**
4. Tap **Done**

## Troubleshooting

| Problem | Fix |
|---------|-----|
| "Invalid JSON" | Check Request Body format (no trailing commas) |
| "Rate limit exceeded" | Add Authorization header with API key |
| "Recent sync already completed" | Normal - wait 10 minutes |
| No recordings synced | Check if recordings have transcripts |

## Advanced: Show Sync Results

Replace step 4 with:

1. **Get Dictionary from Input**
   - Input: "Contents of URL"

2. **If**
   - Condition: "Dictionary has key 'success'"
   - **If True:**
     - **Get Dictionary Value** → Key: "result"
     - **Get Dictionary Value** from "Dictionary Value" → Key: "synced"
     - **Show Notification**
       - Title: "Sync Success"
       - Body: "Synced: [Get Dictionary Value]"
   - **Otherwise:**
     - **Show Notification**
       - Title: "Sync Failed"
       - Body: "Contents of URL"

**Visual:**
```
┌─────────────────────────────────────┐
│ Get Dictionary from Contents of URL │
├─────────────────────────────────────┤
│ If Dictionary has key "success"     │
│                                     │
│ ✓ Get value for "result.synced"    │
│ ✓ Show Notification                 │
│   "Synced: [value]"                 │
│                                     │
│ Otherwise                           │
│ ✓ Show Notification                 │
│   "Error: [Contents of URL]"        │
└─────────────────────────────────────┘
```

## Widget Version (Home Screen)

1. Long-press on shortcut → **Add to Home Screen**
2. Customize icon/name
3. Tap to sync manually

## Siri Voice Command

1. Select shortcut → **ⓘ Details**
2. **Add to Siri**
3. Record phrase: "Sync my notes"

Then say: "Hey Siri, sync my notes"

## Example Automation Recipes

### Recipe 1: Every 4 Hours During Work

```
Automation: Time of Day
Time: 9:00 AM
Repeat: Every 4 hours
End Repeat: 9:00 PM
Action: Run Shortcut → Sync Limitless
Ask Before Running: OFF
```

### Recipe 2: Arriving Home

```
Automation: Arrive
Location: Home
Action: Run Shortcut → Sync Limitless
Ask Before Running: OFF
```

### Recipe 3: Connected to Home Wi-Fi

```
Automation: Wi-Fi
Network: Home-WiFi
Action: Run Shortcut → Sync Limitless
Ask Before Running: OFF
```

### Recipe 4: End of Workday

```
Automation: Leave
Location: Office
Time Range: 5:00 PM - 7:00 PM
Action: Run Shortcut → Sync Limitless
Ask Before Running: OFF
```

## Response Codes

| Status | Meaning | Action |
|--------|---------|--------|
| **200** | Success | Sync completed |
| **200 + skipped** | Too recent | Normal - wait 10 min |
| **400** | Invalid request | Check JSON format |
| **401** | Unauthorized | Add/check API key |
| **429** | Rate limited | Add API key or wait |
| **500** | Server error | Check server logs |

## Example Responses

**Success:**
```json
{
  "success": true,
  "result": {
    "synced": 3,
    "skipped": 1,
    "errors": 0
  },
  "message": "Successfully synced 3 recording(s)"
}
```

**Skipped (too recent):**
```json
{
  "success": true,
  "skipped": true,
  "reason": "Recent sync already completed",
  "nextAllowedSync": "2026-01-25T10:25:00Z"
}
```

**Error:**
```json
{
  "error": "Too Many Requests",
  "retryAfter": 45
}
```

## Tips

💡 **Use authentication** for automated triggers (higher rate limit)

💡 **Turn off "Ask Before Running"** for true automation

💡 **Test manually first** before enabling automation

💡 **Check notification** to verify it's working

💡 **One trigger is enough** - don't stack multiple automations

## Common Mistakes

❌ **Trailing comma in JSON:**
```json
{
  "userId": "test",   ← Remove this comma
}
```

❌ **Missing quotes:**
```json
{
  userId: test  ← Should be "userId": "test"
}
```

❌ **Wrong method:**
```
Method: GET  ← Should be POST
```

❌ **Missing Content-Type:**
```
Headers: (empty)  ← Must include Content-Type: application/json
```

## Getting Help

1. **Test with manual tap first**
2. **Check notification for error details**
3. **Verify credentials with server admin**
4. **Try without authentication first**
5. **Check server logs** (if you have access)

## Full Documentation

For detailed setup, troubleshooting, and advanced features:
→ See `IPHONE_SYNC_SETUP.md`

---

**Need help?** Contact your server administrator with:
- Shortcut screenshot
- Error message from notification
- Approximate time of issue
