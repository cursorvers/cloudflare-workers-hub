# Cloudflare Workers Hub

Multi-channel webhook orchestrator running on Cloudflare Workers. Receives events from Slack, Discord, Telegram, WhatsApp, and GitHub, normalizes them, and routes to AI-powered processing pipelines.

## Features

- **Multi-Channel Webhooks** - Slack, Discord, Telegram, WhatsApp, GitHub, Stripe
- **AI Processing** - Workers AI integration with text generation and embeddings
- **Knowledge Base** - Semantic search via Vectorize + D1 + R2 (Obsidian vault sync)
- **Task Queue** - Durable Object-coordinated lease-based queue with KV storage
- **Scheduled Jobs** - Cron-triggered digests (daily/weekly/monthly/annual)
- **Voice Transcription** - Whisper-based audio processing via R2 staging
- **Limitless.ai Sync** - Pendant lifelog ingestion and processing pipeline
- **Google Slides Generation** - Auto-generate presentations from digests
- **Rate Limiting** - Per-channel sliding window with KV + in-memory fallback
- **Security** - Constant-time auth, HMAC verification, Zod validation, log sanitization

## Architecture

```
Webhook Sources                    Cloudflare Workers
┌──────────────┐                  ┌──────────────────────────┐
│ Slack        │──┐               │  index.ts (Router)       │
│ Discord      │──┤               │    ├─ handlers/          │
│ Telegram     │──┼──── HTTPS ───▶│    │  ├─ slack.ts        │
│ WhatsApp     │──┤               │    │  ├─ discord.ts      │
│ GitHub       │──┤               │    │  ├─ telegram.ts     │
│ Stripe       │──┘               │    │  ├─ whatsapp.ts     │
└──────────────┘                  │    │  ├─ queue.ts        │
                                  │    │  └─ scheduled.ts    │
                                  │    ├─ services/          │
                                  │    │  ├─ knowledge.ts    │
                                  │    │  ├─ transcription.ts│
                                  │    │  ├─ limitless.ts    │
                                  │    │  └─ google-slides.ts│
                                  │    └─ utils/             │
                                  │       ├─ rate-limiter.ts │
                                  │       ├─ api-auth.ts     │
                                  │       └─ log-sanitizer.ts│
                                  └──────────────────────────┘
                                           │
                                  ┌────────┴────────┐
                                  │   Bindings       │
                                  ├─ AI (Workers AI) │
                                  ├─ DB (D1)         │
                                  ├─ CACHE (KV)      │
                                  ├─ OBSIDIAN_VAULT  │
                                  │   (R2)           │
                                  ├─ KNOWLEDGE_INDEX │
                                  │   (Vectorize)    │
                                  └─ TASK_COORDINATOR│
                                     (Durable Object)│
                                  └─────────────────┘
```

## Quick Start

```bash
# Install dependencies
npm install

# Run tests
npm test

# Local development
npx wrangler dev

# Deploy
npx wrangler deploy
```

## Project Structure

```
src/
├── index.ts                    # Entry point, request routing
├── router.ts                   # Source detection utilities
├── types.ts                    # Shared type definitions (Env, events)
├── handlers/
│   ├── channels/               # Channel-specific webhook handlers
│   │   ├── telegram.ts
│   │   └── whatsapp.ts
│   ├── discord.ts
│   ├── slack.ts
│   ├── health.ts               # Health check + metrics
│   ├── queue.ts                # Task queue API (lease-based)
│   ├── scheduled.ts            # Cron job dispatcher
│   ├── memory-api.ts           # Conversation history API
│   ├── cron-api.ts             # Scheduled task management
│   ├── admin-api.ts            # API key management
│   └── daemon-api.ts           # Daemon health monitoring
├── services/
│   ├── knowledge.ts            # Knowledge base (D1 + R2 + Vectorize)
│   ├── transcription.ts        # Voice message transcription
│   ├── limitless.ts            # Limitless.ai Pendant integration
│   ├── lifelog-processor.ts    # Lifelog classification + processing
│   ├── digest-generator.ts     # Weekly/monthly/annual digest generation
│   ├── supabase-client.ts      # Supabase REST client
│   ├── google-slides.ts        # Google Slides generation (Route A)
│   ├── google-auth.ts          # Google OAuth/ADC authentication
│   └── notebooklm.ts           # NotebookLM Enterprise integration
├── schemas/                    # Zod validation schemas
├── utils/
│   ├── api-auth.ts             # API key verification + IDOR prevention
│   ├── rate-limiter.ts         # Sliding window rate limiter
│   ├── log-sanitizer.ts        # Credential masking in logs
│   ├── secrets-validator.ts    # Startup secret validation
│   ├── monitoring.ts           # Metrics + SLO tracking
│   ├── sentry.ts               # Error reporting
│   └── task-index.ts           # KV task index utilities
└── durable-objects/
    └── task-coordinator.ts     # Atomic task claim coordination
```

## Environment Variables

See `src/types.ts` for the full `Env` interface. Key variables:

| Variable | Required | Description |
|----------|----------|-------------|
| `ENVIRONMENT` | Yes | `development` / `production` |
| `SLACK_BOT_TOKEN` | No | Slack Bot OAuth token |
| `SLACK_SIGNING_SECRET` | No | Slack request signing secret |
| `DISCORD_BOT_TOKEN` | No | Discord bot token |
| `DISCORD_PUBLIC_KEY` | No | Discord Ed25519 public key |
| `TELEGRAM_BOT_TOKEN` | No | Telegram bot token |
| `WHATSAPP_ACCESS_TOKEN` | No | WhatsApp Business API token |
| `QUEUE_API_KEY` | No | API key for queue endpoints |
| `MEMORY_API_KEY` | No | API key for memory endpoints |
| `ADMIN_API_KEY` | No | API key for admin endpoints |
| `SUPABASE_URL` | No | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | No | Supabase service role key |
| `LIMITLESS_API_KEY` | No | Limitless.ai API key |

## Cron Schedules

| Schedule | Handler | Description |
|----------|---------|-------------|
| `0 * * * *` | Hourly sync | Limitless.ai lifelog backup |
| `0 21 * * *` | Daily actions | Action item check (6AM JST) |
| `0 0 * * SUN` | Weekly digest | Weekly summary (Sunday 9AM JST) |
| `0 0 1 * *` | Monthly digest | Monthly summary (1st, 9AM JST) |
| `0 0 2 1 *` | Annual digest | Annual summary (Jan 2nd, 9AM JST) |

## Testing

```bash
# Run all tests
npx vitest run

# Watch mode
npx vitest

# Coverage report
npx vitest run --coverage
```

## Bindings

| Binding | Type | Purpose |
|---------|------|---------|
| `AI` | Workers AI | Text generation, embeddings |
| `DB` | D1 | Knowledge base metadata |
| `CACHE` | KV | Rate limiting, task queue, config |
| `OBSIDIAN_VAULT` | R2 | Markdown note storage |
| `KNOWLEDGE_INDEX` | Vectorize | Semantic search vectors |
| `AUDIO_STAGING` | R2 | Voice message processing |
| `TASK_COORDINATOR` | Durable Object | Atomic task claim |

## Security

- Constant-time API key comparison (timing attack prevention)
- Per-channel HMAC/signature verification (Slack, Discord, Telegram, WhatsApp)
- Zod schema validation on all inputs
- Log sanitization (credential masking)
- Scoped API keys with IDOR prevention
- Rate limiting on all endpoints

## License

Private
