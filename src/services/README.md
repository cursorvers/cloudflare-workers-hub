# Services

This directory contains core services for the Cloudflare Workers Hub.

## Available Services

### Transcription Service

A robust Whisper-based audio transcription service for Cloudflare Workers AI.

## Features

✅ **Multiple Input Formats**
- ArrayBuffer (direct binary data)
- Base64 encoded strings (with or without data URL prefix)

✅ **Automatic Retry Logic**
- Exponential backoff (1s → 2s → 4s)
- Up to 3 retry attempts
- Graceful error handling

✅ **Large File Support**
- Automatic chunking for files >25MB
- Chunks processed at 20MB each
- Results automatically merged

✅ **WebVTT Subtitles**
- Generated from word-level timestamps
- Standard VTT format
- Ready for video players

✅ **Language Support**
- Optional language hints (ISO 639-1 codes)
- Automatic language detection
- Confidence scoring

## Installation

The service uses the Cloudflare Workers AI binding with the Whisper large v3 turbo model:

```typescript
import { transcribeAudio } from './services/transcription';
```

## Usage

### Basic Transcription

```typescript
import { transcribeAudio } from './services/transcription';

// From ArrayBuffer
const audioBuffer = await audioFile.arrayBuffer();
const result = await transcribeAudio(env, audioBuffer);

console.log(result.text); // "Hello, this is a test transcription."
console.log(result.confidence); // 0.85
console.log(result.language); // "en"
```

### With Language Hint

```typescript
const result = await transcribeAudio(env, audioBuffer, {
  language: 'ja', // Japanese
});
```

### From Base64

```typescript
const base64Audio = 'data:audio/mp3;base64,/+MYxAAEaAIEeUAQA...';
const result = await transcribeAudio(env, base64Audio);
```

### Generate Subtitles

```typescript
const result = await transcribeAudio(env, audioBuffer);

if (result.vtt) {
  // Save or return the WebVTT file
  return new Response(result.vtt, {
    headers: {
      'Content-Type': 'text/vtt',
      'Content-Disposition': 'attachment; filename="subtitles.vtt"',
    },
  });
}
```

## API Reference

### `transcribeAudio(env, audio, options?)`

**Parameters:**

- `env: Env` - Cloudflare Workers environment with AI binding
- `audio: ArrayBuffer | string` - Audio data (binary or Base64)
- `options?: TranscriptionOptions` - Optional configuration
  - `language?: string` - ISO 639-1 language code (e.g., 'en', 'ja', 'es')

**Returns:** `Promise<TranscriptionResult>`

```typescript
interface TranscriptionResult {
  text: string;              // Transcribed text
  language: string;          // Detected or specified language
  confidence: number;        // 0.0 - 1.0 confidence score
  duration_seconds?: number; // Estimated audio duration
  vtt?: string;             // WebVTT subtitles (if available)
}
```

**Throws:**
- `Error` - If transcription fails after max retries
- `Error` - If Base64 data is invalid

## Supported Languages

The Whisper model supports 100+ languages. Common ISO 639-1 codes:

| Code | Language |
|------|----------|
| `en` | English |
| `ja` | Japanese |
| `es` | Spanish |
| `fr` | French |
| `de` | German |
| `zh` | Chinese |
| `ko` | Korean |
| `ru` | Russian |

[Full list of supported languages](https://github.com/openai/whisper#available-models-and-languages)

## File Size Limits

| Size | Behavior |
|------|----------|
| < 25MB | Single request to Workers AI |
| ≥ 25MB | Automatic chunking (20MB chunks) |

**Note:** Cloudflare Workers have a 25MB request body limit. Large files are automatically split and processed sequentially.

## Error Handling

### Retry Logic

```typescript
try {
  const result = await transcribeAudio(env, audioBuffer);
} catch (error) {
  // Failed after 3 retry attempts
  console.error('Transcription failed:', error);
}
```

### Validation Errors

```typescript
try {
  const result = await transcribeAudio(env, audioBuffer, {
    language: 123, // Invalid: must be string
  });
} catch (error) {
  // Zod validation error
}
```

## Examples

See [transcription.example.ts](./transcription.example.ts) for complete examples:

1. **Upload Handler** - Handle multipart form data
2. **Base64 API** - Process Base64 from webhooks
3. **URL Fetching** - Transcribe from external URLs
4. **Subtitle Generation** - Generate VTT files
5. **Batch Processing** - Process multiple files in parallel
6. **Confidence Threshold** - Filter low-confidence results

## WebVTT Format

When word timestamps are available, the service generates WebVTT subtitles:

```vtt
WEBVTT

1
00:00:00.000 --> 00:00:00.500
Hello

2
00:00:00.600 --> 00:00:01.000
world
```

This format is compatible with:
- HTML5 `<video>` elements
- YouTube
- Most video players

## Performance

### Benchmarks

| File Size | Processing Time | Chunks |
|-----------|----------------|--------|
| 1MB | ~2 seconds | 1 |
| 10MB | ~5 seconds | 1 |
| 25MB | ~10 seconds | 1 |
| 50MB | ~25 seconds | 3 |

**Note:** Times are approximate and depend on Workers AI availability and audio complexity.

### Optimization Tips

1. **Use language hints** when known - improves accuracy and speed
2. **Compress audio files** - smaller files process faster
3. **Use appropriate formats** - MP3, WAV, M4A, OGG are well-supported
4. **Batch similar languages** - process files of the same language together

## Testing

Run the test suite:

```bash
npm test src/services/transcription.test.ts
```

**Test Coverage:**
- ✅ ArrayBuffer input
- ✅ Base64 input (with/without data URL)
- ✅ Language hints
- ✅ WebVTT generation
- ✅ Retry logic
- ✅ Error handling
- ✅ Large file chunking
- ✅ Result merging
- ✅ Confidence calculation
- ✅ Options validation

## Architecture

```
┌─────────────┐
│   Client    │
└──────┬──────┘
       │ Audio (ArrayBuffer/Base64)
       ▼
┌─────────────────────────────┐
│  transcribeAudio()          │
│  - Validate options         │
│  - Convert to ArrayBuffer   │
│  - Check file size          │
└──────┬──────────────────────┘
       │
       ├─── <25MB ────┐
       │              ▼
       │    ┌─────────────────────┐
       │    │ transcribeWithRetry │
       │    │ - Retry logic       │
       │    │ - Exponential back. │
       │    └──────┬──────────────┘
       │           ▼
       │    ┌─────────────────────┐
       │    │ performTranscription│
       │    │ - Call Workers AI   │
       │    │ - Generate VTT      │
       │    └─────────────────────┘
       │
       └─── ≥25MB ────┐
                      ▼
            ┌──────────────────────┐
            │ transcribeWithChunk  │
            │ - Split into 20MB    │
            │ - Process chunks     │
            │ - Merge results      │
            └──────────────────────┘
```

## Contributing

When adding features:

1. **Add tests** - Maintain >80% coverage
2. **Update types** - Keep TypeScript definitions accurate
3. **Document** - Update this README
4. **Follow patterns** - Use existing error handling and logging

## License

MIT

## Related

- [Cloudflare Workers AI Documentation](https://developers.cloudflare.com/workers-ai/)
- [Whisper Model Card](https://github.com/openai/whisper)
- [WebVTT Specification](https://www.w3.org/TR/webvtt1/)

---

# Knowledge Service

A multi-tier knowledge storage service with semantic search capabilities for Cloudflare Workers.

## Features

✅ **Multi-tier Storage Architecture**
- **R2**: Stores full markdown content in `OBSIDIAN_VAULT` bucket
- **Vectorize**: Stores embeddings for semantic search in `KNOWLEDGE_INDEX`
- **D1**: Stores metadata with full-text search (FTS5) capability

✅ **Semantic Search**
- Uses Workers AI (@cf/baai/bge-base-en-v1.5) for embeddings
- Vector similarity search via Vectorize
- Automatic fallback to full-text search

✅ **Graceful Degradation**
- Works with partial bindings (only R2 required)
- Falls back to FTS if Vectorize unavailable
- Skips metadata if D1 unavailable

✅ **Flexible Input**
- Support for multiple sources: telegram, whatsapp, discord, line, manual
- Multiple types: voice_note, conversation, document
- Optional audio file paths, tags, timestamps

## Installation

```typescript
import { storeKnowledge, searchKnowledge } from './services/knowledge';
```

## Usage

### Store a Knowledge Item

```typescript
import { storeKnowledge } from './services/knowledge';

const item = {
  userId: 'user123',
  source: 'telegram',
  type: 'voice_note',
  title: 'Meeting Notes',
  content: 'Discussed project timeline and milestones. Key decisions made...',
  tags: ['meeting', 'project'],
  audioPath: 'audio/user123/message.ogg', // Optional
};

const id = await storeKnowledge(env, item);
console.log('Stored with ID:', id); // "lz1h2k3-abc12de"
```

### Search Knowledge Items

```typescript
import { searchKnowledge } from './services/knowledge';

// Semantic search (if Vectorize configured)
const results = await searchKnowledge(
  env,
  'project timeline',
  'user123',
  10 // limit (default: 10)
);

console.log('Found', results.length, 'items');
results.forEach(item => {
  console.log(`${item.title}: ${item.content}`);
});
```

### Markdown Storage Format

Stored markdown files include frontmatter:

```markdown
---
title: Meeting Notes
source: telegram
type: voice_note
userId: user123
createdAt: 2024-01-25T10:00:00Z
tags: [meeting, project]
audioPath: audio/user123/message.ogg
---

# Meeting Notes

Discussed project timeline and milestones. Key decisions made...
```

## API Reference

### `storeKnowledge(env, item)`

**Parameters:**

- `env: Env` - Cloudflare Workers environment
- `item: KnowledgeItem` - Knowledge item to store

**Returns:** `Promise<string>` - Generated item ID

**Throws:**
- Validation error if required fields missing
- Error if R2 bucket not configured
- Error if storage fails

```typescript
interface KnowledgeItem {
  id?: string;                    // Auto-generated if not provided
  userId: string;                 // Required - user identifier
  source: 'telegram' | 'whatsapp' | 'discord' | 'line' | 'manual';
  type: 'voice_note' | 'conversation' | 'document';
  title: string;                  // Required - item title
  content: string;                // Required - markdown content
  audioPath?: string;             // Optional - path to audio file in R2
  tags?: string[];                // Optional - tags for categorization
  createdAt?: string;             // ISO 8601 datetime (auto-generated)
}
```

### `searchKnowledge(env, query, userId, limit?)`

**Parameters:**

- `env: Env` - Cloudflare Workers environment
- `query: string` - Search query
- `userId: string` - User ID to filter results
- `limit?: number` - Max results (default: 10)

**Returns:** `Promise<KnowledgeItem[]>` - Array of matching items

**Search Strategy:**
1. Try semantic search (Vectorize) if available
2. Fall back to full-text search (D1 FTS) if semantic fails
3. Return empty array if no search capabilities available

**Throws:**
- Error if query or userId is empty

## Database Schema

See `/migrations/0004_knowledge_items.sql`:

```sql
CREATE TABLE knowledge_items (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  source TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT,
  content_preview TEXT,
  r2_path TEXT NOT NULL,
  audio_path TEXT,
  vectorize_id TEXT,
  language TEXT NOT NULL DEFAULT 'ja',
  word_count INTEGER,
  tags TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  synced_at TEXT
);

-- Full-text search virtual table
CREATE VIRTUAL TABLE knowledge_fts USING fts5(
  title, content_preview, tags,
  content='knowledge_items'
);
```

## Configuration

Required bindings in `wrangler.toml`:

```toml
# R2 bucket for markdown content (REQUIRED)
[[r2_buckets]]
binding = "OBSIDIAN_VAULT"
bucket_name = "obsidian-vault"

# Vectorize for semantic search (OPTIONAL, recommended)
[[vectorize]]
binding = "KNOWLEDGE_INDEX"
index_name = "obsidian-knowledge"

# D1 for metadata and full-text search (OPTIONAL)
[[d1_databases]]
binding = "DB"
database_name = "knowledge-base"
database_id = "4164f0fc-d6bb-4e78-86d1-2601d762d6de"
```

## Migration Setup

Run the D1 migration:

```bash
wrangler d1 execute knowledge-base --file=./migrations/0004_knowledge_items.sql
```

Create Vectorize index:

```bash
wrangler vectorize create obsidian-knowledge \
  --dimensions=768 \
  --metric=cosine
```

## Error Handling

### Input Validation

```typescript
try {
  const id = await storeKnowledge(env, {
    userId: '',  // Invalid: empty
    source: 'telegram',
    type: 'voice_note',
    title: 'Test',
    content: 'Test content',
  });
} catch (error) {
  // Zod validation error: "User ID is required"
}
```

### Graceful Degradation

```typescript
// R2 only (no Vectorize or D1)
const env = {
  OBSIDIAN_VAULT: r2Bucket,
  // No KNOWLEDGE_INDEX
  // No DB
};

const id = await storeKnowledge(env, item);
// ✅ Still works - stores in R2, skips embedding & metadata

const results = await searchKnowledge(env, 'query', 'user123');
// ✅ Returns empty array (no search capability)
```

### Search Fallback

```typescript
// Vectorize fails → automatic fallback to FTS
const results = await searchKnowledge(env, 'project', 'user123');
// Tries Vectorize first
// If error: logs warning and tries D1 FTS
// If both fail: returns empty array
```

## Testing

Run tests:

```bash
npm test -- src/services/knowledge.test.ts
```

**Test Coverage:**
- ✅ Input validation (Zod schemas)
- ✅ Storage operations (R2, Vectorize, D1)
- ✅ Semantic search with embeddings
- ✅ Full-text search fallback
- ✅ Graceful degradation scenarios
- ✅ Error handling and retries
- ✅ Content extraction from markdown
- ✅ Tag parsing and storage

All 14 tests passing ✓

## Architecture

```
┌─────────────┐
│   Client    │
└──────┬──────┘
       │ KnowledgeItem
       ▼
┌─────────────────────────────┐
│  storeKnowledge()           │
│  - Validate with Zod        │
│  - Generate ID if needed    │
└──────┬──────────────────────┘
       │
       ├──► R2 Storage (REQUIRED)
       │    └─ Store markdown with frontmatter
       │
       ├──► Vectorize (OPTIONAL)
       │    ├─ Generate embedding (Workers AI)
       │    └─ Store vector with metadata
       │
       └──► D1 Metadata (OPTIONAL)
            └─ Store searchable metadata + FTS

┌─────────────┐
│   Client    │
└──────┬──────┘
       │ Query
       ▼
┌─────────────────────────────┐
│  searchKnowledge()          │
│  - Check available bindings │
└──────┬──────────────────────┘
       │
       ├──► Vectorize Search (PRIORITY 1)
       │    ├─ Generate query embedding
       │    ├─ Vector similarity search
       │    └─ Fetch content from R2
       │
       └──► D1 FTS Search (FALLBACK)
            ├─ Full-text search on metadata
            └─ Fetch content from R2
```

## Performance

### Storage Performance

| Operation | Time | Notes |
|-----------|------|-------|
| R2 Put | ~50ms | Depends on content size |
| Embedding Generation | ~100ms | 768-dim vector |
| Vectorize Upsert | ~30ms | Single vector |
| D1 Insert | ~20ms | Metadata only |
| **Total** | ~200ms | With all bindings |

### Search Performance

| Search Type | Time | Accuracy |
|-------------|------|----------|
| Semantic (Vectorize) | ~150ms | High |
| Full-text (D1 FTS) | ~50ms | Medium |

### Optimization Tips

1. **Use tags** - Improves FTS recall
2. **Limit results** - Default to 10, max 50
3. **Cache frequent queries** - Use KV for hot queries
4. **Batch storage** - Store multiple items in parallel

## Examples

### Voice Note from Telegram

```typescript
const transcription = await transcribeAudio(env, audioBuffer);

const id = await storeKnowledge(env, {
  userId: telegramUserId,
  source: 'telegram',
  type: 'voice_note',
  title: `Voice note from ${userName}`,
  content: transcription.text,
  audioPath: `audio/${telegramUserId}/${messageId}.ogg`,
  tags: ['voice', 'telegram'],
});
```

### Conversation Log

```typescript
const conversation = messages.map(m =>
  `${m.user}: ${m.text}`
).join('\n\n');

const id = await storeKnowledge(env, {
  userId: channelId,
  source: 'discord',
  type: 'conversation',
  title: `Discord conversation - ${new Date().toISOString()}`,
  content: conversation,
  tags: ['discord', 'chat-log'],
});
```

### Manual Document

```typescript
const id = await storeKnowledge(env, {
  userId: 'user123',
  source: 'manual',
  type: 'document',
  title: 'Project Requirements',
  content: markdownContent,
  tags: ['requirements', 'project-alpha'],
});
```

---

## Limitless Service

Integration with Limitless.ai API for syncing Pendant voice recordings.

### Features

✅ **Lifelog Fetching**
- Fetch recent lifelogs from Limitless API
- Support for pagination with cursors
- Time range filtering

✅ **Audio Download**
- Download audio as Ogg Opus or MP3
- Maximum 2 hours per download
- Automatic validation

✅ **Knowledge Sync**
- Sync lifelogs to knowledge service
- Optional audio storage in R2
- Batch processing with pagination

✅ **Retry Logic**
- Exponential backoff (1s → 2s → 4s)
- Up to 3 retry attempts
- Skip retry for client errors (4xx)

### Basic Usage

```typescript
import { syncToKnowledge } from './services/limitless';

// Sync last 24 hours of recordings
const result = await syncToKnowledge(env, apiKey, {
  userId: 'user-123',
  maxAgeHours: 24,
  includeAudio: false,
});

console.log(`Synced: ${result.synced}`);
console.log(`Skipped: ${result.skipped}`);
console.log(`Errors: ${result.errors.length}`);
```

### API Endpoints

**GET** `/api/limitless/sync?userId=<userId>`
- Manual sync trigger for a user
- Requires `MONITORING_API_KEY`

**POST** `/api/limitless/sync`
- Custom sync with options
- Requires `MONITORING_API_KEY`

**GET** `/api/limitless/config`
- Get current configuration
- Requires `MONITORING_API_KEY`

### Configuration

Set `LIMITLESS_API_KEY` in your environment:

```bash
wrangler secret put LIMITLESS_API_KEY
```

### More Information

See [docs/LIMITLESS_INTEGRATION.md](../../docs/LIMITLESS_INTEGRATION.md) for detailed documentation and examples.

---

## Contributing

When extending these services:

1. **Add tests** - Maintain test coverage
2. **Update schema** - Create new migrations for D1 changes
3. **Document** - Update this README
4. **Follow patterns** - Use Zod, safeLog, graceful degradation

## License

MIT
