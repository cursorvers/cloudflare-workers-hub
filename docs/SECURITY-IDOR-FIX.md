# IDOR Vulnerability Fix - Security Documentation

## Overview

**Fixed**: Insecure Direct Object Reference (IDOR) vulnerability in Memory and Cron APIs.

**Severity**: High (OWASP A01:2021 - Broken Access Control)

## Vulnerability Description

### Before Fix

Memory and Cron APIs derived userId from URL path parameters, which could be spoofed by attackers:

```http
GET /api/memory/context/victim_123
X-API-Key: attacker_key

→ Would return victim's data if API key was valid for ANY user
```

**Attack Scenario**:
1. Attacker obtains valid API key for their own account
2. Attacker modifies URL to request another user's userId
3. API validates the key (passes) but doesn't verify userId ownership
4. Attacker accesses victim's conversation history, preferences, or scheduled tasks

### After Fix

API now derives userId from cryptographic API key mapping stored in KV:

```http
GET /api/memory/context/victim_123
X-API-Key: attacker_key

→ 403 Forbidden (userId mismatch detected)
```

**Protection Mechanism**:
1. API key → SHA-256 hash (first 16 chars)
2. KV lookup: `apikey:mapping:{hash}` → `{ userId: "..." }`
3. Compare requested userId vs. derived userId (constant-time)
4. Return 403 if mismatch

---

## Implementation Details

### New Functions

#### `hashAPIKey(apiKey: string): Promise<string>`

Hashes API key using SHA-256 and returns first 16 characters.

**Purpose**: Create non-reversible key identifier for KV storage without exposing full keys.

**Example**:
```typescript
const hash = await hashAPIKey('sk-abc123...');
// hash = "a1b2c3d4e5f6g7h8" (16 chars)
```

---

#### `extractUserIdFromKey(apiKey: string, env: Env): Promise<string | null>`

Extracts userId from API key by looking up KV mapping.

**Returns**:
- `string`: userId if mapping exists
- `null`: if mapping doesn't exist or CACHE unavailable

**KV Key Format**: `apikey:mapping:{hash}`

**KV Value Format**: `{ "userId": "user_12345" }`

**Example**:
```typescript
const userId = await extractUserIdFromKey('sk-abc123...', env);
if (userId) {
  // Proceed with userId
} else {
  // Mapping not found
}
```

---

#### `authorizeUserAccess(request: Request, requestedUserId: string, env: Env): Promise<boolean>`

Verifies that requested userId matches the userId derived from API key.

**Security Features**:
- Constant-time comparison to prevent timing attacks
- Fails closed (returns false on any error)
- Logs authorization failures with masked userIds

**Returns**:
- `true`: Authorized (userId match)
- `false`: Unauthorized (userId mismatch or error)

**Example**:
```typescript
if (!await authorizeUserAccess(request, 'user_123', env)) {
  return new Response(JSON.stringify({ error: 'Forbidden' }), {
    status: 403,
    headers: { 'Content-Type': 'application/json' },
  });
}
```

---

## Protected Endpoints

### Memory API (7 endpoints)

| Endpoint | Method | userId Source | Protection |
|----------|--------|---------------|------------|
| `/api/memory/context/:userId` | GET | URL path | ✅ Added |
| `/api/memory/history/:userId` | GET | URL path | ✅ Added |
| `/api/memory/save` | POST | Request body (`user_id`) | ✅ Added |
| `/api/memory/preferences/:userId` | GET | URL path | ✅ Added |
| `/api/memory/preferences` | POST | Request body (`user_id`) | ✅ Added |

### Cron API (8 endpoints)

| Endpoint | Method | userId Source | Protection |
|----------|--------|---------------|------------|
| `/api/cron/tasks/:userId` | GET | URL path | ✅ Added |
| `/api/cron/tasks` | POST | Request body (`user_id`) | ✅ Added |
| `/api/cron/task/:id` | GET | Task owner | ✅ Added |
| `/api/cron/task/:id` | PUT | Task owner | ✅ Added |
| `/api/cron/task/:id` | DELETE | Task owner | ✅ Added |
| `/api/cron/task/:id/toggle` | POST | Task owner | ✅ Added |
| `/api/cron/task/:id/executed` | POST | Task owner | ✅ Added |

**Note**: Task-specific endpoints fetch the task first to determine the owner's userId, then verify authorization.

---

## Admin API for Key Management

### POST /api/admin/apikey/mapping

Creates API key → userId mapping.

**Request**:
```json
{
  "apiKey": "sk-user-key-12345",
  "userId": "user_12345"
}
```

**Response**:
```json
{
  "success": true,
  "keyHash": "a1b2c3d4",
  "userId": "user_12345"
}
```

**Requirements**:
- Admin API key required (`ADMIN_API_KEY`)
- Rate limited (admin scope)

---

### DELETE /api/admin/apikey/mapping

Deletes API key mapping.

**Request**:
```json
{
  "apiKey": "sk-user-key-12345"
}
```

**Response**:
```json
{
  "success": true,
  "keyHash": "a1b2c3d4"
}
```

---

## Setup Instructions

### 1. Create API Key Mappings

Use the admin endpoint or CLI script:

**Option A: Admin API** (recommended)
```bash
curl -X POST https://your-worker.workers.dev/api/admin/apikey/mapping \
  -H "X-API-Key: $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"apiKey":"sk-user-123","userId":"user_123"}'
```

**Option B: CLI Script**
```bash
npx tsx scripts/create-api-key-mapping.ts "sk-user-123" "user_123"
```

**Option C: Wrangler CLI**
```bash
wrangler kv:key put --binding=CACHE \
  "apikey:mapping:a1b2c3d4e5f6g7h8" \
  '{"userId":"user_12345"}'
```

### 2. Verify Mapping

```bash
wrangler kv:key get --binding=CACHE "apikey:mapping:{hash}"
```

### 3. Test Authorization

```bash
# Should succeed (own data)
curl -X GET https://your-worker.workers.dev/api/memory/context/user_123 \
  -H "X-API-Key: sk-user-123"

# Should fail with 403 (IDOR attempt)
curl -X GET https://your-worker.workers.dev/api/memory/context/user_456 \
  -H "X-API-Key: sk-user-123"
```

---

## Security Considerations

### Constant-Time Comparison

All userId comparisons use constant-time algorithms to prevent timing attacks:

```typescript
// Length check first (early rejection)
if (derivedUserId.length !== requestedUserId.length) {
  return false;
}

// Constant-time character comparison
let result = 0;
for (let i = 0; i < derivedUserId.length; i++) {
  result |= derivedUserId.charCodeAt(i) ^ requestedUserId.charCodeAt(i);
}

return result === 0;
```

**Why**: Prevents attackers from inferring userId by measuring response time.

### Secure Logging

Authorization failures are logged with masked userIds:

```typescript
safeLog.warn('[API] Authorization failed', {
  requested: maskUserId('user_12345'), // → 'user_***45'
  derived: maskUserId('user_67890'),   // → 'user_***90'
});
```

**Why**: Prevents sensitive data leakage in logs.

### API Key Hashing

API keys are hashed (SHA-256, first 16 chars) before storage:

```typescript
const keyHash = await hashAPIKey(apiKey);
// Stored as: "apikey:mapping:a1b2c3d4e5f6g7h8"
```

**Why**: Prevents key exposure if KV is compromised.

### Fail-Closed Design

All authorization functions fail closed:

```typescript
// Returns false on any error
if (!env.CACHE) return null;
if (!mapping) return null;
if (!mapping.userId) return null;
```

**Why**: Ensures security by default.

---

## Migration Guide

### For Existing Deployments

1. **Create mappings for all existing API keys**:
   ```bash
   for key in $EXISTING_KEYS; do
     curl -X POST .../api/admin/apikey/mapping \
       -H "X-API-Key: $ADMIN_API_KEY" \
       -d "{\"apiKey\":\"$key\",\"userId\":\"$USER_ID\"}"
   done
   ```

2. **Deploy the updated worker**:
   ```bash
   npm run deploy
   ```

3. **Verify protection**:
   ```bash
   # Test IDOR attempt (should fail)
   curl -X GET .../api/memory/context/other_user \
     -H "X-API-Key: your_key"
   ```

4. **Monitor logs** for authorization failures:
   ```bash
   wrangler tail --format json | grep "Authorization failed"
   ```

### For New Deployments

1. Set `ADMIN_API_KEY` in Cloudflare Workers environment
2. Create API key mappings via admin endpoint
3. Deploy worker
4. Test authorization

---

## Testing

Run the test suite:

```bash
npm test
```

**Test Coverage**:
- ✅ Hash function correctness
- ✅ Mapping lookup
- ✅ Authorization logic
- ✅ Constant-time comparison
- ✅ IDOR attack prevention
- ✅ Edge cases (null, empty, malformed)
- ✅ Secure logging

**Coverage Target**: 80%+ for security-critical code

---

## OWASP Compliance

| OWASP Top 10 | Status | Implementation |
|--------------|--------|----------------|
| A01:2021 - Broken Access Control | ✅ Fixed | API key → userId mapping with authorization check |
| A02:2021 - Cryptographic Failures | ✅ Compliant | SHA-256 hashing, constant-time comparison |
| A09:2021 - Security Logging Failures | ✅ Compliant | Authorization failures logged with masking |

---

## Performance Impact

### KV Reads

Each protected endpoint adds 1 KV read:

```
verifyAPIKey() → existing
    +
extractUserIdFromKey() → +1 KV read
```

**Mitigation**: KV reads are fast (~1-5ms) and results can be cached per-request.

### Future Optimization

Consider caching userId in request context:

```typescript
// First call: KV lookup
const userId = await extractUserIdFromKey(apiKey, env);
ctx.userId = userId; // Cache in ExecutionContext

// Subsequent calls: use cached value
const userId = ctx.userId || await extractUserIdFromKey(apiKey, env);
```

---

## Monitoring

### Key Metrics

| Metric | Alert Threshold | Action |
|--------|----------------|--------|
| `Authorization failed` logs | >10/min | Investigate potential attack |
| `No userId mapping found` logs | >5/min | Check mapping creation process |
| 403 responses | >5% of requests | Audit API key distribution |

### Log Examples

**Successful Authorization**:
```json
{
  "level": "info",
  "message": "[Memory API] Request authorized",
  "userId": "user_***45"
}
```

**Failed Authorization (IDOR attempt)**:
```json
{
  "level": "warn",
  "message": "[Memory API] Unauthorized access attempt",
  "endpoint": "/context",
  "requested": "user_***90",
  "derived": "user_***45"
}
```

---

## Rollback Plan

If issues arise, rollback by:

1. Deploy previous version: `wrangler rollback`
2. Remove authorization checks temporarily (not recommended)
3. Fix and redeploy within 24 hours

---

## References

- OWASP IDOR: https://owasp.org/www-community/attacks/Insecure_Direct_Object_References
- Constant-time comparison: https://codahale.com/a-lesson-in-timing-attacks/
- Cloudflare KV: https://developers.cloudflare.com/workers/runtime-apis/kv/
