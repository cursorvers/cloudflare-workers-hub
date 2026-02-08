# Monitoring Endpoint Authentication

This document describes the authentication mechanism for health and metrics endpoints in the Cloudflare Workers Hub.

## Overview

The `/health` and `/metrics` endpoints now support API key authentication to prevent unauthorized access to sensitive monitoring data.

## Security Features

1. **Constant-time comparison** - Prevents timing attacks
2. **Scoped API keys** - `MONITORING_API_KEY` for dedicated monitoring access
3. **Fallback support** - Falls back to `ADMIN_API_KEY` if monitoring key not set
4. **Backward compatibility** - Allows public access if no keys configured
5. **Security logging** - Logs all unauthorized access attempts

## Configuration

### Environment Variables

Add one or both of these environment variables to your Workers deployment:

```bash
# Recommended: Dedicated monitoring key
MONITORING_API_KEY=your-secure-monitoring-key

# Alternative: Use admin key as fallback
ADMIN_API_KEY=your-admin-key
```

### Priority Order

When both keys are configured:

1. `MONITORING_API_KEY` (highest priority)
2. `ADMIN_API_KEY` (fallback)
3. No authentication (backward compatibility)

## Usage

### With Authentication

```bash
# Health check with API key
curl -H "X-API-Key: your-monitoring-key" https://your-worker.workers.dev/health

# Metrics with API key
curl -H "X-API-Key: your-monitoring-key" https://your-worker.workers.dev/metrics
```

### Without Authentication (Legacy)

If neither `MONITORING_API_KEY` nor `ADMIN_API_KEY` is configured, endpoints remain publicly accessible:

```bash
# Public access (when no keys configured)
curl https://your-worker.workers.dev/health
curl https://your-worker.workers.dev/metrics
```

## Migration Guide

### Phase 1: Initial Setup (No Authentication)

Current state - no changes needed:

```bash
# Endpoints are publicly accessible
curl https://your-worker.workers.dev/health
```

### Phase 2: Add ADMIN_API_KEY (Gradual Migration)

Add `ADMIN_API_KEY` as a Workers secret (recommended):

```bash
# Canonical (orchestrator-hub)
wrangler secret put ADMIN_API_KEY --env ""

# Optional canary
wrangler secret put ADMIN_API_KEY --env canary
```

Now you need to include the API key:

```bash
curl -H "X-API-Key: your-admin-key" https://your-worker.workers.dev/health
```

### Phase 3: Add MONITORING_API_KEY (Recommended Final State)

Create a dedicated monitoring key (recommended):

Set both secrets:

```bash
wrangler secret put MONITORING_API_KEY --env ""
wrangler secret put ADMIN_API_KEY --env ""
```

Use the monitoring key:

```bash
curl -H "X-API-Key: your-monitoring-key" https://your-worker.workers.dev/health
```

## Response Codes

| Code | Meaning | Reason |
|------|---------|--------|
| 200 | Success | Valid API key or no authentication required |
| 401 | Unauthorized | Invalid API key, missing key, or key mismatch |

## Error Responses

### Missing API Key (when required)

```json
{
  "error": "Unauthorized"
}
```

**Logged as:**
```
[Monitoring] Missing API key
```

### Invalid API Key

```json
{
  "error": "Unauthorized"
}
```

**Logged as:**
```
[Monitoring] Invalid API key
```

### No Keys Configured (Backward Compatibility)

Returns normal response (200 OK) but logs a warning:

```
[Monitoring] No MONITORING_API_KEY or ADMIN_API_KEY configured - allowing public access
```

## Security Best Practices

### 1. Use Strong Keys

Generate cryptographically secure random keys:

```bash
# Generate a secure key (Unix/macOS)
openssl rand -base64 32

# Generate a secure key (Windows PowerShell)
[Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Minimum 0 -Maximum 256 }))
```

### 2. Separate Keys by Environment

Use different keys for development, staging, and production:

```bash
# dev (if you use a dedicated Wrangler env)
wrangler secret put MONITORING_API_KEY --env development

# canonical (orchestrator-hub)
wrangler secret put MONITORING_API_KEY --env ""

# optional canary (orchestrator-hub-canary)
wrangler secret put MONITORING_API_KEY --env canary
```

### 3. Rotate Keys Regularly

Implement a key rotation schedule (e.g., every 90 days):

1. Generate new key
2. Update Cloudflare secrets
3. Update monitoring tools
4. Deploy changes
5. Verify old key no longer works

### 4. Restrict Access

Only share monitoring keys with:
- Monitoring systems (Datadog, Prometheus, etc.)
- On-call engineers
- CI/CD pipelines (for health checks)

### 5. Monitor Failed Attempts

Set up alerts for repeated 401 errors:

```javascript
// Example alert rule (pseudo-code)
if (failed_auth_attempts > 10 in 5 minutes) {
  notify("Potential brute force attack on monitoring endpoints")
}
```

## Integration Examples

### Datadog

Add the API key to your Datadog HTTP check:

```yaml
instances:
  - url: https://your-worker.workers.dev/health
    headers:
      X-API-Key: your-monitoring-key
    timeout: 5
```

### Prometheus

Configure Prometheus to include the API key:

```yaml
scrape_configs:
  - job_name: 'cloudflare-workers'
    static_configs:
      - targets: ['your-worker.workers.dev']
    scheme: https
    metrics_path: /metrics
    bearer_token: your-monitoring-key  # Or use header
```

### GitHub Actions (CI/CD)

Store the key as a secret and use it in health checks:

```yaml
- name: Health Check
  run: |
    curl -f -H "X-API-Key: ${{ secrets.MONITORING_API_KEY }}" \
      https://your-worker.workers.dev/health
```

## Troubleshooting

### Issue: Getting 401 Unauthorized

**Check:**
1. Is the API key correctly set in environment variables?
2. Are you sending the key in the `X-API-Key` header?
3. Is the key exactly matching (no extra spaces)?

**Debug:**
```bash
# Check what you're sending
curl -v -H "X-API-Key: your-key" https://your-worker.workers.dev/health

# Verify environment variable is set
wrangler tail | grep MONITORING
```

### Issue: Public access still works

**This is expected if:**
- Neither `MONITORING_API_KEY` nor `ADMIN_API_KEY` is configured
- This is backward compatibility behavior

**To enforce authentication:**
Set at least one of the API keys in your environment variables.

### Issue: Want to disable public access completely

Set either `MONITORING_API_KEY` or `ADMIN_API_KEY` to enforce authentication:

```bash
wrangler secret put MONITORING_API_KEY --env ""
```

Now all requests without a valid API key will receive 401 Unauthorized.

## Implementation Details

### Constant-Time Comparison

The verification uses constant-time comparison to prevent timing attacks:

```typescript
// Constant-time comparison
let result = 0;
for (let i = 0; i < apiKey.length; i++) {
  result |= apiKey.charCodeAt(i) ^ expectedKey.charCodeAt(i);
}

return result === 0;  // True if all characters match
```

This ensures that:
- Comparison time doesn't leak information about the key
- Attackers can't use timing differences to guess the key

### Logging

All authentication attempts are logged using `safeLog`:

- **Success:** No log (to avoid noise)
- **Missing key:** `[Monitoring] Missing API key`
- **Invalid key:** `[Monitoring] Invalid API key`
- **No keys configured:** `[Monitoring] No MONITORING_API_KEY or ADMIN_API_KEY configured - allowing public access`

Logs do not include:
- The actual API key (security)
- User identifiable information (privacy)

## Related Documentation

- [Queue API Authentication](../src/handlers/queue.ts) - Similar API key verification
- [Admin API](../src/handlers/admin-api.ts) - Admin endpoint authentication
- [Security Best Practices](./SECURITY.md) - General security guidelines
