# Deployment Targets (Accident-Proof)

This repo intentionally treats **hub (envless)** as the canonical production script.
Canary exists for smoke-testing deploys without changing the hub script.

## Targets

- **hub (canonical prod)**
  - Script: `orchestrator-hub`
  - URL: `https://orchestrator-hub.masa-stage1.workers.dev`
  - Deploy: `npm run release:hub`

- **canary**
  - Script: `orchestrator-hub-canary` (Wrangler env: `canary`)
  - URL: `https://orchestrator-hub-canary.masa-stage1.workers.dev`
  - Deploy: `npm run release:canary`

## Canary Safety (Accident-Proof Defaults)

Canary is meant for smoke-testing deploys without touching the hub script.

- Canary should be bound to **isolated resources** (D1/KV/R2) so write endpoints (like receipt uploads) are safe.
- freee integration should be **disabled on canary** so a stray OAuth login can't upload/create deals.

### Optional Write Gate

If canary ever shares production resources, you can block all write methods (non-GET/HEAD/OPTIONS) via:

- Config: `DEPLOY_TARGET=canary`
- Switch: `CANARY_WRITE_ENABLED=false` (returns 403 for write methods)

In this repo, `wrangler.toml` currently sets `CANARY_WRITE_ENABLED=true` because canary uses a separate D1/KV/R2.

## Split Resources (D1/KV/R2) For True Isolation

If you want canary to be truly isolated (no shared production data), you must create separate Cloudflare resources
and then point `wrangler.toml` `[env.canary.*]` bindings to them.

Minimum recommended split for receipts:

- D1: `knowledge-base-canary`
- KV: a separate namespace for `CACHE` / `USAGE_CACHE` / `KV` (can be 1 namespace reused, or 3 distinct ones)
- R2: `receipt-worm-storage-canary`

Suggested workflow:

1. Create resources in Cloudflare:

```bash
# D1
npx wrangler d1 create knowledge-base-canary

# KV (example: one shared namespace for all 3 bindings)
npx wrangler kv namespace create orchestrator-hub-canary-kv

# R2
npx wrangler r2 bucket create receipt-worm-storage-canary
```

2. Update `wrangler.toml`:

- Replace `[[env.canary.d1_databases]]` `database_name`/`database_id`
- Replace `[[env.canary.kv_namespaces]]` `id`
- Replace `[[env.canary.r2_buckets]]` `bucket_name`

3. Apply D1 migrations to the new canary DB (remote):

```bash
npx wrangler d1 migrations apply DB --env canary --remote
```

4. Deploy canary:

```bash
npm run release:canary
```

### D1 Migrations

Applying D1 migrations changes the underlying D1 database. If canary shares the production DB (current default),
**migrations for canary are effectively production migrations**.

- Local release script:
  - `npm run release:hub` applies migrations (remote) and deploys
  - `npm run release:canary` deploys only (no migrations by default)
  - `bash scripts/release-worker.sh canary --apply-migrations` opt-in for canary
- GitHub Actions (Release Worker):
  - `apply_migrations=hub_only` (default): hub applies, canary skips
  - `apply_migrations=always`: canary also applies (use only when intended)

## Legacy Worker (Deprecated)

`orchestrator-hub-production.masa-stage1.workers.dev` is treated as **legacy/deprecated**.
It is kept only for backward-compatible CORS/CSRF allowlists, and is not a deploy target.

If you confirm there's no traffic, plan a controlled shutdown (disable routes / delete script) to remove the long-term risk.

## Local Dev

Use the dedicated dev env (safe defaults, no cron):

```bash
npm run dev
```
