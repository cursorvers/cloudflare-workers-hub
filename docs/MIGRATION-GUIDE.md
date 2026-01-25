# Migration Guide: IDOR Fix Deployment

## Overview

This guide helps you deploy the IDOR vulnerability fix to existing deployments.

**Critical**: Existing API keys will stop working until you create userId mappings.

---

## Pre-Deployment Checklist

- [ ] Inventory all existing API keys
- [ ] Identify the userId for each API key
- [ ] Set `ADMIN_API_KEY` in Cloudflare environment
- [ ] Test in staging environment first
- [ ] Prepare rollback plan

---

## Step 1: Set ADMIN_API_KEY

### Via Cloudflare Dashboard

1. Go to Workers & Pages
2. Select `cloudflare-workers-hub`
3. Settings → Variables
4. Add environment variable:
   - Name: `ADMIN_API_KEY`
   - Value: `admin-{random-64-chars}`
   - Type: Secret (encrypted)

### Via Wrangler CLI

```bash
wrangler secret put ADMIN_API_KEY
# Paste your admin key when prompted
```

**Generate secure key**:
```bash
openssl rand -base64 48
```

---

## Step 2: Deploy the Updated Worker

### Deploy to Staging First

```bash
npm run deploy
```

**Verify deployment**:
```bash
curl https://your-worker.workers.dev/health
```

---

## Step 3: Create API Key Mappings

### Option A: Admin API (Recommended for Production)

```bash
#!/bin/bash
# create-mappings.sh

ADMIN_KEY="your-admin-key-here"
WORKER_URL="https://your-worker.workers.dev"

# Array of API keys and their corresponding userIds
declare -a MAPPINGS=(
  "sk-user-alice-12345:alice_123"
  "sk-user-bob-67890:bob_456"
  "sk-daemon-key-abc:daemon_001"
)

for mapping in "${MAPPINGS[@]}"; do
  IFS=':' read -r API_KEY USER_ID <<< "$mapping"

  echo "Creating mapping for $USER_ID..."

  curl -X POST "$WORKER_URL/api/admin/apikey/mapping" \
    -H "X-API-Key: $ADMIN_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"apiKey\":\"$API_KEY\",\"userId\":\"$USER_ID\"}"

  echo ""
done
```

**Run**:
```bash
chmod +x create-mappings.sh
./create-mappings.sh
```

### Option B: Wrangler KV CLI (For Local/Staging)

```bash
# 1. Generate hash for API key
npx tsx scripts/create-api-key-mapping.ts "sk-user-key" "user_123"

# 2. Copy the Wrangler command from output
# Example output:
# wrangler kv:key put --binding=CACHE "apikey:mapping:a1b2c3d4e5f6g7h8" '{"userId":"user_123"}'

# 3. Run the command
wrangler kv:key put --binding=CACHE "apikey:mapping:a1b2c3d4e5f6g7h8" '{"userId":"user_123"}'
```

### Option C: Bulk Import via JSON

```bash
# 1. Create mappings.json
cat > mappings.json << 'EOF'
[
  { "apiKey": "sk-user-alice-12345", "userId": "alice_123" },
  { "apiKey": "sk-user-bob-67890", "userId": "bob_456" }
]
EOF

# 2. Import via script
for row in $(cat mappings.json | jq -c '.[]'); do
  curl -X POST https://your-worker.workers.dev/api/admin/apikey/mapping \
    -H "X-API-Key: $ADMIN_API_KEY" \
    -H "Content-Type: application/json" \
    -d "$row"
done
```

---

## Step 4: Verify Mappings

### Check KV Storage

```bash
wrangler kv:key list --binding=CACHE --prefix="apikey:mapping:"
```

### Test Authorization

```bash
# Test 1: Legitimate access (should succeed)
curl -X GET https://your-worker.workers.dev/api/memory/context/alice_123 \
  -H "X-API-Key: sk-user-alice-12345"

# Expected: 200 OK with context data

# Test 2: IDOR attempt (should fail)
curl -X GET https://your-worker.workers.dev/api/memory/context/bob_456 \
  -H "X-API-Key: sk-user-alice-12345"

# Expected: 403 Forbidden
# Response: {"error":"Forbidden"}
```

---

## Step 5: Monitor Logs

```bash
wrangler tail --format json
```

**Watch for**:

| Log Message | Meaning | Action |
|-------------|---------|--------|
| `Authorization failed: userId mismatch` | IDOR attempt blocked | Normal (security working) |
| `No userId mapping found for API key` | Missing mapping | Create mapping |
| `CACHE KV namespace not available` | Configuration error | Check wrangler.toml |

**Sample Logs**:

```json
// Success
{
  "level": "info",
  "message": "[Memory API] Request authorized",
  "userId": "user_***23"
}

// IDOR blocked
{
  "level": "warn",
  "message": "[Memory API] Unauthorized access attempt",
  "endpoint": "/context",
  "requested": "user_***56",
  "derived": "user_***23"
}
```

---

## Step 6: Deploy to Production

### Pre-Production Checklist

- [ ] All mappings created in production KV
- [ ] ADMIN_API_KEY set in production environment
- [ ] Staging tests passed (100% success rate)
- [ ] Team notified of deployment
- [ ] Rollback plan ready

### Deploy

```bash
npm run deploy:production
```

### Post-Deployment Verification

```bash
# 1. Health check
curl https://production-worker.workers.dev/health

# 2. Test legitimate access
curl -X GET https://production-worker.workers.dev/api/memory/context/{your-userId} \
  -H "X-API-Key: {your-key}"

# 3. Monitor error rates
wrangler tail --env production
```

---

## Troubleshooting

### Issue 1: "No userId mapping found for API key"

**Symptom**: 403 Forbidden for legitimate users

**Cause**: Missing API key → userId mapping

**Solution**:
```bash
curl -X POST https://your-worker.workers.dev/api/admin/apikey/mapping \
  -H "X-API-Key: $ADMIN_API_KEY" \
  -d '{"apiKey":"<user-api-key>","userId":"<user-id>"}'
```

### Issue 2: "CACHE KV namespace not available"

**Symptom**: 500 Internal Server Error

**Cause**: KV binding not configured

**Solution**:
Check `wrangler.toml`:
```toml
[[kv_namespaces]]
binding = "CACHE"
id = "your-kv-namespace-id"
```

### Issue 3: High 403 rate after deployment

**Symptom**: >10% of requests return 403

**Cause**: Incomplete mapping migration

**Solution**:
1. Check logs: `wrangler tail | grep "No userId mapping"`
2. Identify missing mappings
3. Create missing mappings via admin API
4. Monitor until 403 rate normalizes (<1%)

### Issue 4: ADMIN_API_KEY not working

**Symptom**: 401 Unauthorized on admin endpoints

**Cause**: Key mismatch or not set

**Solution**:
```bash
# Verify key is set
wrangler secret list

# Update key
wrangler secret put ADMIN_API_KEY
```

---

## Rollback Procedure

### Immediate Rollback (Recommended)

```bash
wrangler rollback
```

**Restores**: Previous deployment (IDOR vulnerable but functional)

### Manual Rollback

1. Go to Cloudflare Dashboard → Workers & Pages
2. Select deployment
3. Deployments → Rollbacks
4. Select previous version
5. Click "Rollback"

### Emergency Bypass (LAST RESORT)

If rollback fails and users are locked out:

**⚠️ Security Warning**: This temporarily re-introduces the IDOR vulnerability.

1. Comment out authorization checks in code
2. Deploy emergency fix
3. Fix mapping issues
4. Re-enable authorization within 24 hours
5. Conduct security audit

---

## Validation Criteria

### Success Criteria

- ✅ 0% of legitimate users receive 403
- ✅ 100% of IDOR attempts blocked (403)
- ✅ Authorization logs show correct userId masking
- ✅ KV read latency <50ms p95
- ✅ No false positives for 24 hours

### Acceptance Testing

```bash
# Test Suite
./test-idor-protection.sh

# Manual Tests
1. Legitimate user accesses own data → 200 OK
2. User A tries to access User B's data → 403 Forbidden
3. Admin creates new mapping → 201 Created
4. Admin deletes mapping → 200 OK
5. Deleted key attempts access → 403 Forbidden
```

---

## Long-Term Monitoring

### Weekly Audit (First Month)

```bash
# Count authorization failures
wrangler tail --env production --format json | \
  grep "Authorization failed" | \
  wc -l

# Identify top blocked users (potential attackers)
wrangler tail --format json | \
  grep "Authorization failed" | \
  jq -r '.requested' | \
  sort | uniq -c | sort -nr | head -10
```

### Monthly Review

- Review 403 error rate trends
- Audit new API key mappings
- Update documentation if usage patterns change
- Security team review of authorization logs

---

## Contact & Support

### Security Issues

For critical security issues, contact: security@your-domain.com

### Deployment Issues

For deployment problems, contact: devops@your-domain.com

### Questions

For general questions, see: [docs/SECURITY-IDOR-FIX.md](SECURITY-IDOR-FIX.md)

---

## Appendix: Example Mapping Script

```typescript
// bulk-create-mappings.ts
import { readFileSync } from 'fs';

interface Mapping {
  apiKey: string;
  userId: string;
}

async function createMappings(mappings: Mapping[], workerUrl: string, adminKey: string) {
  for (const { apiKey, userId } of mappings) {
    const response = await fetch(`${workerUrl}/api/admin/apikey/mapping`, {
      method: 'POST',
      headers: {
        'X-API-Key': adminKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ apiKey, userId }),
    });

    const result = await response.json();

    if (response.ok) {
      console.log(`✅ Created mapping for ${userId}`);
    } else {
      console.error(`❌ Failed for ${userId}:`, result.error);
    }
  }
}

// Load from file
const mappings: Mapping[] = JSON.parse(readFileSync('mappings.json', 'utf-8'));
const workerUrl = process.env.WORKER_URL || 'https://your-worker.workers.dev';
const adminKey = process.env.ADMIN_API_KEY || '';

createMappings(mappings, workerUrl, adminKey).catch(console.error);
```

**Usage**:
```bash
ADMIN_API_KEY=your-key WORKER_URL=https://your-worker.workers.dev \
  npx tsx bulk-create-mappings.ts
```
