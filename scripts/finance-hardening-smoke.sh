#!/usr/bin/env bash
set -euo pipefail

: "${WORKER_BASE_URL:?WORKER_BASE_URL is required}"
: "${ADMIN_API_KEY:?ADMIN_API_KEY is required}"
: "${RECEIPT_OPERATIONAL_TENANT_ID:?RECEIPT_OPERATIONAL_TENANT_ID is required}"

auth_header="Authorization: Bearer ${ADMIN_API_KEY}"
tenant_header="X-Tenant-Id: ${RECEIPT_OPERATIONAL_TENANT_ID}"

echo "[smoke] finance status"
curl -sS "${WORKER_BASE_URL}/api/finance/status?sample_limit=5" \
  -H "${auth_header}" \
  -H "${tenant_header}"
printf '\n'

echo "[smoke] finance dry-run"
curl -sS -X POST "${WORKER_BASE_URL}/api/finance/run" \
  -H "${auth_header}" \
  -H "${tenant_header}" \
  -H "Content-Type: application/json" \
  -d '{"dry_run":true,"operations":["repair_html_text","retry_failed","repair_freee_links","backfill_receipts"]}'
printf '\n'

echo "[smoke] receipts poll"
curl -sS -X POST "${WORKER_BASE_URL}/api/receipts/poll" \
  -H "${auth_header}" \
  -H "${tenant_header}"
printf '\n'
