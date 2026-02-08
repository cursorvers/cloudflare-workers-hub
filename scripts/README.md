# API Key Management Scripts

## create-api-key-mapping.ts

Creates API key → userId mappings for IDOR protection.

### Usage

```bash
npx tsx scripts/create-api-key-mapping.ts <apiKey> <userId>
```

### Example

```bash
npx tsx scripts/create-api-key-mapping.ts "sk-user-alice-12345" "alice_123"
```

### Output

The script will generate a Wrangler command to create the mapping:

```bash
wrangler kv:key put --binding=CACHE "apikey:mapping:a1b2c3d4e5f6g7h8" '{"userId":"alice_123"}'
```

### What It Does

1. Hashes the API key using SHA-256
2. Takes the first 16 characters of the hash
3. Generates a KV key: `apikey:mapping:{hash}`
4. Outputs the Wrangler command to store `{ userId: "..." }`

### Security

- API key is hashed, not stored in plain text
- Hash is truncated to 16 chars (sufficient for uniqueness)
- Mapping is stored in KV, not in code

### Alternative: Use Admin API

Instead of running this script locally, you can use the Admin API endpoint:

```bash
curl -X POST https://your-worker.workers.dev/api/admin/apikey/mapping \
  -H "X-API-Key: $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"apiKey":"sk-user-key","userId":"user_123"}'
```

This is the recommended approach for production.

## Bundle Size Measurement

- `npm run measure:unpdf`
  - Measures the bundled size contribution of `unpdf` using a tiny entrypoint.
- `npm run measure:worker`
  - Runs `wrangler build` locally and prints the Worker upload size line.

## Ops Helpers

- `bash scripts/trigger-receipts-poll.sh`
  - Triggers Gmail receipt polling via `POST /api/receipts/poll` (requires `ADMIN_API_KEY`).

## Queue Auth Key Drift Prevention

`/api/queue` will return HTTP 401 if the daemon/monitor key drifts from the Worker secrets.

- `bash scripts/sync-queue-api-keys.sh`
  - Ensures `QUEUE_API_KEY` and `ASSISTANT_API_KEY` (both default + production) match local `ASSISTANT_API_KEY` from `scripts/.env.assistant`.
  - This script is safe to run repeatedly and will no-op when auth already works.
- `npm run sync:queue-keys`
  - Convenience wrapper for the same script.

Optional automation (LaunchAgent):
- `~/Library/LaunchAgents/com.cloudflare-workers-hub.queue-key-sync.plist`
  - Runs the sync script every 30 minutes and logs to `Dev/cloudflare-workers-hub/logs/queue-key-sync.log`.
