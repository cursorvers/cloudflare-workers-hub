# Limitless.ai Integration

Integration with Limitless.ai API for syncing Pendant voice recordings to the knowledge service.

## Overview

The Limitless integration provides automatic syncing of voice recordings from the Limitless Pendant to your knowledge base. Recordings are processed, transcribed, and stored alongside your other notes and conversations.

## Features

- ✅ Fetch recent lifelogs from Limitless API
- ✅ Download audio recordings as Ogg Opus (max 2 hours)
- ✅ Sync lifelogs to knowledge service
- ✅ Automatic retry logic with exponential backoff
- ✅ Pagination support for large result sets
- ✅ Graceful degradation when services are unavailable

## Configuration

### Environment Variables

Add the following to your `wrangler.toml` or Cloudflare Dashboard:

```toml
[vars]
LIMITLESS_API_KEY = "your-limitless-api-key"
```

Or set as a secret:

```bash
wrangler secret put LIMITLESS_API_KEY
```

### Optional Configuration

Default values are provided, but you can customize:

- `syncIntervalMinutes`: How often to sync (default: 60 minutes)
- `maxAgeHours`: Maximum age of recordings to fetch (default: 24 hours)

## API Endpoints

### Manual Sync Trigger

**GET** `/api/limitless/sync?userId=<userId>`

Trigger a manual sync for a specific user.

**Headers:**
- `Authorization: Bearer <MONITORING_API_KEY>` or
- `X-API-Key: <MONITORING_API_KEY>`

**Query Parameters:**
- `userId` (required): User ID to sync recordings for

**Response:**
```json
{
  "success": true,
  "result": {
    "synced": 5,
    "skipped": 2,
    "errors": []
  }
}
```

**Example:**
```bash
curl -X GET "https://your-worker.workers.dev/api/limitless/sync?userId=user123" \
  -H "X-API-Key: your-monitoring-api-key"
```

### Custom Sync

**POST** `/api/limitless/sync`

Sync with custom options.

**Headers:**
- `Authorization: Bearer <MONITORING_API_KEY>` or
- `X-API-Key: <MONITORING_API_KEY>`
- `Content-Type: application/json`

**Request Body:**
```json
{
  "userId": "user123",
  "maxAgeHours": 48,
  "includeAudio": true
}
```

**Parameters:**
- `userId` (required): User ID to sync recordings for
- `maxAgeHours` (optional): Maximum age of recordings (1-168 hours, default: 24)
- `includeAudio` (optional): Whether to download and store audio files (default: false)

**Response:**
```json
{
  "success": true,
  "result": {
    "synced": 10,
    "skipped": 1,
    "errors": []
  }
}
```

**Example:**
```bash
curl -X POST "https://your-worker.workers.dev/api/limitless/sync" \
  -H "X-API-Key: your-monitoring-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "user123",
    "maxAgeHours": 48,
    "includeAudio": true
  }'
```

### Get Configuration

**GET** `/api/limitless/config`

Get current Limitless integration configuration.

**Headers:**
- `Authorization: Bearer <MONITORING_API_KEY>` or
- `X-API-Key: <MONITORING_API_KEY>`

**Response:**
```json
{
  "configured": true,
  "defaultMaxAgeHours": 24,
  "defaultIncludeAudio": false
}
```

## Programmatic Usage

### Import the Service

```typescript
import {
  getRecentLifelogs,
  getLifelog,
  downloadAudio,
  syncToKnowledge,
} from './services/limitless';
```

### Fetch Recent Lifelogs

```typescript
const { lifelogs, cursor } = await getRecentLifelogs('your-api-key', {
  limit: 20,
  startTime: '2024-01-25T00:00:00Z',
  endTime: '2024-01-25T23:59:59Z',
});

console.log(`Fetched ${lifelogs.length} lifelogs`);
```

### Get Specific Lifelog

```typescript
const lifelog = await getLifelog('your-api-key', 'lifelog-id-123');

console.log(`Title: ${lifelog.summary}`);
console.log(`Transcript: ${lifelog.transcript}`);
```

### Download Audio

```typescript
const audioBuffer = await downloadAudio('your-api-key', {
  startTime: '2024-01-25T10:00:00Z',
  endTime: '2024-01-25T10:30:00Z',
  format: 'ogg',
});

console.log(`Downloaded ${audioBuffer.byteLength} bytes`);
```

### Sync to Knowledge Service

```typescript
const result = await syncToKnowledge(env, 'your-api-key', {
  userId: 'user123',
  maxAgeHours: 24,
  includeAudio: false,
});

console.log(`Synced: ${result.synced}`);
console.log(`Skipped: ${result.skipped}`);
console.log(`Errors: ${result.errors.length}`);
```

## How It Works

### 1. Fetch Lifelogs

The service fetches recent lifelogs from the Limitless API using the `/lifelogs` endpoint.

- Supports pagination via cursor
- Filters by time range
- Validates all responses with Zod schemas

### 2. Process Lifelogs

Each lifelog is processed:

- Skip if no transcript or summary
- Create knowledge item with:
  - Title: Summary or generated from timestamp
  - Content: Transcript or summary
  - Tags: From lifelog tags
  - Created date: From lifelog startTime

### 3. Download Audio (Optional)

If `includeAudio` is enabled:

- Download audio from Limitless API (max 2 hours)
- Store in R2 bucket (`AUDIO_STAGING`)
- Link audio path to knowledge item

### 4. Store in Knowledge Service

The processed lifelog is stored using the knowledge service:

- Content stored in R2 (`OBSIDIAN_VAULT`)
- Embeddings generated and stored in Vectorize
- Metadata stored in D1 database

### 5. Error Handling

- Automatic retry with exponential backoff
- Graceful degradation when services unavailable
- Detailed error logging with safeLog
- Collection of errors for reporting

## Data Flow

```
┌──────────────────┐
│ Limitless API    │
│ (Pendant)        │
└────────┬─────────┘
         │
         │ 1. Fetch lifelogs
         ▼
┌──────────────────┐
│ Limitless        │
│ Service          │
└────────┬─────────┘
         │
         │ 2. Process & validate
         ▼
┌──────────────────┐
│ Knowledge        │
│ Service          │
└────────┬─────────┘
         │
         ├─────► R2 (markdown)
         ├─────► Vectorize (embeddings)
         └─────► D1 (metadata)
```

## Error Handling

### Automatic Retries

Failed API requests are automatically retried:

- Max retries: 3
- Exponential backoff: 1s, 2s, 4s
- Skip retry for 4xx errors (client errors)

### Graceful Degradation

- Continue sync if individual lifelog fails
- Continue without audio if download fails
- Collect errors for reporting

### Logging

All operations are logged with `safeLog`:

```typescript
safeLog.info('[Limitless] Fetching lifelogs', { limit: 20 });
safeLog.error('[Limitless] Failed to sync', { error: String(error) });
```

## Rate Limiting

API requests are rate-limited to prevent abuse:

- Endpoint: `limitless`
- Key: First 8 characters of API key
- Uses existing rate limiter from `utils/rate-limiter`

## Security

### API Key Protection

- Limitless API key stored as environment variable
- Never logged or exposed in responses
- Transmitted only in request headers

### Input Validation

All inputs validated with Zod:

- API keys must be non-empty strings
- Time ranges must be valid ISO 8601
- Duration limited to 2 hours for audio
- User IDs must be non-empty

### Authentication

Endpoints require `MONITORING_API_KEY`, `ADMIN_API_KEY`, or `ASSISTANT_API_KEY`.

## Limitations

### Audio Download

- Maximum duration: 2 hours (7200 seconds)
- Format: Ogg Opus or MP3
- Size: Limited by R2 storage

### Sync Interval

- Manual trigger recommended
- Automatic cron sync not yet implemented
- Rate limits apply to API calls

### API Availability

- Requires Limitless API key
- Subject to Limitless API rate limits
- Graceful degradation if API unavailable

## Testing

Run the test suite:

```bash
npm test src/services/limitless.test.ts
```

Tests cover:
- ✅ Fetching recent lifelogs
- ✅ Pagination handling
- ✅ Audio download with validation
- ✅ Sync to knowledge service
- ✅ Error handling and retries
- ✅ Input validation
- ✅ Graceful degradation

## Troubleshooting

### "Limitless API not configured"

Ensure `LIMITLESS_API_KEY` is set in your environment variables.

### "Audio duration exceeds maximum allowed"

The Limitless API limits audio downloads to 2 hours. Split longer recordings.

### "Unauthorized" error

Verify that your `MONITORING_API_KEY` is correct and set in the request headers.

### High skip count

Lifelogs without transcript or summary are skipped. This is normal if the Pendant didn't record meaningful audio.

## Future Enhancements

- [ ] Automatic scheduled sync via cron
- [ ] Support for multiple users
- [ ] Audio transcription integration
- [ ] Summary generation for lifelogs
- [ ] User-specific configuration
- [ ] Webhook support for real-time sync
- [ ] Add 'limitless' to source enum

## Support

For issues or questions:

1. Check the logs in Cloudflare Dashboard
2. Verify environment variables are set
3. Test with manual sync first
4. Review error messages in response

## References

- [Limitless API Documentation](https://api.limitless.ai/docs)
- [Knowledge Service](./KNOWLEDGE_SERVICE.md)
- [Rate Limiting](./RATE_LIMITING.md)
