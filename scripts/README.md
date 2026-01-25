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
