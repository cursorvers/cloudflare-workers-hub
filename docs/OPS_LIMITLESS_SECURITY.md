# Limitless Security Ops (Key Rotation + Webhook Auth)

## 1) Limitless API Key Rotation (Required if exposed)

If a Limitless API key was ever pasted into chat/logs, treat it as compromised and rotate it.

### Steps

1. Create a new Limitless API key in the Limitless dashboard.
2. Update the secret for the dedicated worker (`limitless-sync`):

```bash
cd /Users/masayuki/Dev/cloudflare-workers-hub
npx wrangler secret put LIMITLESS_API_KEY -c wrangler-limitless.toml
```

3. (Optional) If `orchestrator-hub` still uses Limitless endpoints, update it too:

```bash
cd /Users/masayuki/Dev/cloudflare-workers-hub
npx wrangler secret put LIMITLESS_API_KEY -c wrangler.toml --env ""
```

4. Verify the secret is present (value is never shown):

```bash
cd /Users/masayuki/Dev/cloudflare-workers-hub
npx wrangler secret list -c wrangler-limitless.toml
```

5. Revoke the old key in the Limitless dashboard.

## 2) Webhook Auth Hardening (Dedicated Key Boundary)

`/api/limitless/webhook-sync` supports a dedicated secret:

- `LIMITLESS_SYNC_WEBHOOK_KEY`

Behavior:

- If `LIMITLESS_SYNC_WEBHOOK_KEY` is set, it becomes the only accepted Bearer token for this endpoint.
- If it is not set, the endpoint falls back to shared keys (for backward compatibility).

### Verify (no secrets in shell history)

```bash
read -s WEBHOOK_KEY; echo
curl -sS -X POST "https://limitless-sync.masa-stage1.workers.dev/api/limitless/webhook-sync" \
  -H "Authorization: Bearer $WEBHOOK_KEY" \
  -H "Content-Type: application/json" \
  --data '{"userId":"masayuki","maxAgeHours":1,"includeAudio":false}' | jq .
unset WEBHOOK_KEY
```

Expected: `success:true` and `result.synced/skipped/errors`.
