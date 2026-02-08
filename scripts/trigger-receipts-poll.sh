#!/usr/bin/env bash
set -euo pipefail

# Manual trigger for Gmail receipt polling in production.
#
# Requires one of:
# - ADMIN_API_KEY
# - WORKERS_API_KEY (legacy super key)
# Optional:
# - WORKER_URL (default: production worker URL)

# Canonical API is envless worker (orchestrator-hub). Override via WORKER_URL if needed.
WORKER_URL="${WORKER_URL:-https://orchestrator-hub.masa-stage1.workers.dev}"

if [[ -z "${ADMIN_API_KEY:-}" && -z "${WORKERS_API_KEY:-}" ]]; then
  # Convenience: load local env files if present (no output).
  if [[ -f ".env" ]]; then
    set -a
    # shellcheck disable=SC1091
    source ".env" >/dev/null 2>&1 || true
    set +a
  fi
  if [[ -f ".dev.vars" ]]; then
    set -a
    # shellcheck disable=SC1091
    source ".dev.vars" >/dev/null 2>&1 || true
    set +a
  fi
fi

API_KEY="${ADMIN_API_KEY:-${WORKERS_API_KEY:-}}"
if [[ -z "${API_KEY:-}" ]]; then
  echo "Missing ADMIN_API_KEY or WORKERS_API_KEY" >&2
  exit 2
fi

curl -sS -X POST "${WORKER_URL}/api/receipts/poll" \
  -H "Authorization: Bearer ${API_KEY}" \
  -H "Content-Type: application/json"
echo
