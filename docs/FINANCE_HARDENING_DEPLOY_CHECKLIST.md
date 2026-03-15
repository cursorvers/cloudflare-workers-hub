# Finance Hardening Deploy Checklist

対象:
- tenant/company scoped freee token store
- receipt/admin/finance tenant fail-closed
- tenant-aware workflow audit/WORM
- scheduled Gmail/backfill operational tenant gate

前提:
- canonical production target は envless `hub`
- canary は別 D1/KV/R2 のときだけ安全
- 複数 active tenant がある環境では `RECEIPT_OPERATIONAL_TENANT_ID` が必須

## 1. Preflight

```bash
npm run typecheck
npx vitest run src/handlers/receipt-upload.test.ts src/handlers/freee-oauth.test.ts src/handlers/finance-automation-api.test.ts src/handlers/receipt-search.test.ts src/handlers/receipt-freee-repair.test.ts src/handlers/receipt-poller-utils.test.ts src/handlers/receipt-html-text-repair.test.ts
npm run test:production-sim
```

## 2. Required Secrets / Vars

Required:
- `FREEE_CLIENT_ID`
- `FREEE_CLIENT_SECRET`
- `FREEE_REDIRECT_URI`
- `FREEE_ENCRYPTION_KEY`
- `ADMIN_API_KEY` or `WORKERS_API_KEY`
- `RECEIPT_OPERATIONAL_TENANT_ID`

Notes:
- `FREEE_COMPANY_ID` is optional only when OAuth is started with `?company_id=<freee_company_id>`
- if more than one active tenant exists, `RECEIPT_OPERATIONAL_TENANT_ID` must be set before cron/dry-run smoke

## 3. D1 Migration

Primary migration:
- [0029_harden_freee_tokens_and_audit.sql](/Users/masayuki/Dev/cloudflare-workers-hub/migrations/0029_harden_freee_tokens_and_audit.sql)

Command:

```bash
npm run d1:apply:remote
```

Guardrails:
- `0029` is transactional
- `0029` aborts when legacy OAuth tokens exist and multiple active tenants exist
- do not apply against shared DB from canary unless that is intentional

## 4. OAuth Reconnect

Use this when:
- target tenant/company token row does not exist
- company mismatch is detected
- legacy global tokens were invalidated

Start URL:

```text
https://orchestrator-hub.masa-stage1.workers.dev/api/freee/auth?company_id=<freee_company_id>
```

Headers for admin/API-key path:
- `Authorization: Bearer $ADMIN_API_KEY`
- `X-Tenant-Id: $RECEIPT_OPERATIONAL_TENANT_ID`

Expected:
- callback stores token in `external_oauth_tokens(tenant_id, provider, company_id)`
- callback fails closed if multiple companies are returned without explicit `company_id`

## 5. Dry-Run Smoke

Use:
- [scripts/finance-hardening-smoke.sh](/Users/masayuki/Dev/cloudflare-workers-hub/scripts/finance-hardening-smoke.sh)

```bash
export WORKER_BASE_URL="https://orchestrator-hub.masa-stage1.workers.dev"
export ADMIN_API_KEY="..."
export RECEIPT_OPERATIONAL_TENANT_ID="..."

npm run finance:smoke:remote
```

## 6. Go / No-Go

Go only if:
- finance status returns tenant-scoped snapshot
- finance dry-run returns no tenant mismatch or company mismatch
- receipt poll does not fall back to `default`
- OAuth token row exists for target `tenant_id + company_id`
- partial failures are surfaced as non-success / `207`

No-Go if:
- migration `0029` aborts due to multi-tenant legacy token ambiguity
- `RECEIPT_OPERATIONAL_TENANT_ID` is unset in a multi-tenant environment
- freee OAuth is started without `company_id` for a multi-company account
