# Receipt Gmail Automation (Production)

This document covers what is required for fully automated Gmail receipt ingestion in the production Worker.

## Status (as of 2026-02-07)

- Script running the cron: `orchestrator-hub`
- Cron schedule: `*/15 * * * *` (every 15 minutes)
- Scheduled mode: `SCHEDULED_GMAIL_ONLY="true"` (cron runs Gmail polling only)

Note: This repo also supports a separate canary script via Wrangler `env.canary`,
but secrets are not automatically shared across scripts/environments.

## Required Secrets

Set these as **Workers secrets** for the script that actually runs the cron.

Current config: cron runs on `orchestrator-hub` (envless), so set secrets with `--env ""` (or omit `--env`).

- `GMAIL_CLIENT_ID`
- `GMAIL_CLIENT_SECRET`
- `GMAIL_REFRESH_TOKEN`
- `FREEE_CLIENT_ID`
- `FREEE_CLIENT_SECRET`
- `FREEE_REDIRECT_URI`
- `FREEE_ENCRYPTION_KEY`

Recommended:

- `ADMIN_API_KEY` (manual trigger endpoints)
- `MONITORING_API_KEY` (protect `/health` and `/metrics`)
- `RECEIPT_OPERATIONAL_TENANT_ID`
  - Required when more than one active tenant exists in `tenant_users`
  - Used by scheduled Gmail poll / backfill to fail closed instead of silently using `default`

## How To Set Secrets

Use the helper script:

```bash
export GMAIL_CLIENT_ID=...
export GMAIL_CLIENT_SECRET=...
export GMAIL_REFRESH_TOKEN=...
export FREEE_CLIENT_ID=...
export FREEE_CLIENT_SECRET=...
export FREEE_REDIRECT_URI=...
export FREEE_ENCRYPTION_KEY=...
export RECEIPT_OPERATIONAL_TENANT_ID=...   # required in multi-tenant environments
export ADMIN_API_KEY=...            # optional
export MONITORING_API_KEY=...       # optional

bash scripts/set-production-receipts-secrets.sh
```

### If You Want A Separate Canary Script

Cloudflare secrets are per-script. If you want to run the cron on canary (`orchestrator-hub-canary`),
you must set the same Gmail/freee secrets for that script:

```bash
# set secrets on orchestrator-hub-canary:
bash scripts/set-production-receipts-secrets.sh --env canary
```

Then move the cron trigger to `[env.canary.triggers]` in `wrangler.toml` and remove it from top-level `[triggers]`,
and deploy with `npx wrangler deploy --env canary` (this deploys to `orchestrator-hub-canary.*.workers.dev`).

## Manual Verification (One-Off)

Manual poll trigger (admin-scoped):

```bash
export ADMIN_API_KEY=...            # or export WORKERS_API_KEY=...
bash scripts/trigger-receipts-poll.sh
```

Or call directly with a bearer token:

```bash
curl -X POST "https://orchestrator-hub.masa-stage1.workers.dev/api/receipts/poll" \\
  -H "Authorization: Bearer $ADMIN_API_KEY" \\
  -H "X-Tenant-Id: $RECEIPT_OPERATIONAL_TENANT_ID"  # or $WORKERS_API_KEY
```

## Observability

Tail production logs:

```bash
npx wrangler tail orchestrator-hub --format pretty
```

Filter poller logs:

```bash
npx wrangler tail orchestrator-hub --format pretty --search \"\\[Gmail Poller\\]|\\[Scheduled\\]\"
```

## Common Failure Mode

If the cron runs but nothing is processed, production is missing Gmail/freee secrets.
The poller will log warnings like:

- `[Gmail Poller] Gmail credentials not configured, skipping`
- `[Gmail Poller] freee integration not configured, skipping`

## Notes

- `FREEE_COMPANY_ID` is optional. If not set, the Worker resolves it via `GET /companies` and persists it to D1 (`external_oauth_tokens.company_id`).
- OAuth token storage is tenant/company scoped in D1: `tenant_id + provider + company_id`.
- Legacy global tokens are migrated by `migrations/0029_harden_freee_tokens_and_audit.sql`.
  - If multiple active tenants already exist, set `RECEIPT_OPERATIONAL_TENANT_ID` first and review legacy token ownership before applying.

## freee OAuth (Hub Only)

To store tokens into D1, run the OAuth flow once in a browser.

- Production start now requires either:
  - a browser session already authenticated by Cloudflare Access, or
  - an admin API key on the request.
- A plain unauthenticated browser open of `/api/freee/auth` returns `401`.
- Recommended production path: sign in to Cloudflare Access first, then open:
  - Start: `https://orchestrator-hub.masa-stage1.workers.dev/api/freee/auth?company_id=<freee_company_id>`
- Callback: `.../api/freee/callback` (must match `FREEE_REDIRECT_URI` configured in freee and/or Worker secret)
- If the freee account can access multiple companies, `company_id` is mandatory. The callback now fails closed instead of defaulting to the first company.

Canary has `FREEE_INTEGRATION_ENABLED=false`, so `/api/freee/auth` and `/api/freee/callback` return 404 there.

## Migration + Smoke

Apply D1 migrations remotely:

```bash
npm run d1:apply:remote
```

Recommended dry-run smoke after deploy:

```bash
curl -sS "https://orchestrator-hub.masa-stage1.workers.dev/api/finance/status?sample_limit=5" \\
  -H "Authorization: Bearer $ADMIN_API_KEY" \\
  -H "X-Tenant-Id: $RECEIPT_OPERATIONAL_TENANT_ID"

curl -sS -X POST "https://orchestrator-hub.masa-stage1.workers.dev/api/finance/run" \\
  -H "Authorization: Bearer $ADMIN_API_KEY" \\
  -H "X-Tenant-Id: $RECEIPT_OPERATIONAL_TENANT_ID" \\
  -H "Content-Type: application/json" \\
  -d '{"dry_run":true,"operations":["repair_html_text","retry_failed","repair_freee_links","backfill_receipts"]}'
```
