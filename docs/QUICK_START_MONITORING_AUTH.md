# Quick Start: Monitoring Endpoint Authentication

5-minute guide to secure your monitoring endpoints.

## Step 1: Generate a Secure API Key

```bash
# Unix/macOS/Linux
openssl rand -base64 32

# Windows PowerShell
[Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Minimum 0 -Maximum 256 }))
```

Copy the output (e.g., `xK9mP2vQ8rL4wN7eT1uY5jH6gF3dS0aZ`)

## Step 2: Add to Your Worker

### Option A: Via wrangler.toml (Recommended for Development)

```toml
[env.production]
vars = {
  MONITORING_API_KEY = "xK9mP2vQ8rL4wN7eT1uY5jH6gF3dS0aZ"
}
```

### Option B: Via Cloudflare Dashboard (Recommended for Production)

1. Go to Workers & Pages
2. Select your worker
3. Click **Settings** > **Variables**
4. Click **Add variable**
5. Name: `MONITORING_API_KEY`
6. Value: Your generated key
7. Click **Encrypt** (recommended)
8. Click **Save**

## Step 3: Deploy

```bash
wrangler deploy
```

## Step 4: Test

### Without API Key (Should Fail)
```bash
curl https://your-worker.workers.dev/health
# Expected: {"error":"Unauthorized"}
```

### With API Key (Should Succeed)
```bash
curl -H "X-API-Key: xK9mP2vQ8rL4wN7eT1uY5jH6gF3dS0aZ" \
  https://your-worker.workers.dev/health
# Expected: {"status":"healthy",...}
```

## Step 5: Update Monitoring Tools

### Datadog
```yaml
- url: https://your-worker.workers.dev/health
  headers:
    X-API-Key: xK9mP2vQ8rL4wN7eT1uY5jH6gF3dS0aZ
```

### Prometheus
```yaml
- targets: ['your-worker.workers.dev']
  params:
    headers: ['X-API-Key: xK9mP2vQ8rL4wN7eT1uY5jH6gF3dS0aZ']
```

### GitHub Actions
```yaml
- name: Health Check
  env:
    MONITORING_KEY: ${{ secrets.MONITORING_API_KEY }}
  run: |
    curl -f -H "X-API-Key: $MONITORING_KEY" \
      https://your-worker.workers.dev/health
```

## Done! 🎉

Your monitoring endpoints are now secured with API key authentication.

## Troubleshooting

**Getting 401?**
- Check the key is correctly set in environment variables
- Verify you're using `X-API-Key` header (not `Authorization`)
- Ensure no extra spaces or quotes in the key

**Want to keep public access temporarily?**
- Simply don't set `MONITORING_API_KEY` or `ADMIN_API_KEY`
- The endpoints will remain publicly accessible

**Need to rotate the key?**
1. Generate a new key (Step 1)
2. Update environment variable (Step 2)
3. Update monitoring tools (Step 5)
4. Deploy (Step 3)

## Security Reminders

- ✅ Use different keys for dev/staging/prod
- ✅ Store keys in secrets management (not in code)
- ✅ Rotate keys every 90 days
- ✅ Only share with monitoring systems and on-call engineers
- ✅ Monitor failed authentication attempts

For detailed documentation, see [MONITORING_AUTH.md](./MONITORING_AUTH.md)
