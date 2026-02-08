#!/usr/bin/env bash
set -euo pipefail

# Keep Workers Hub queue auth keys in sync with the local canonical key.
#
# Why:
# - /api/queue returns 401 when daemon/monitor key drifts from Worker secrets.
# - This script ensures both QUEUE_API_KEY and ASSISTANT_API_KEY match the local ASSISTANT_API_KEY.
#
# Usage:
#   ./scripts/sync-queue-api-keys.sh
#   ENV_FILE=/path/to/.env.assistant ./scripts/sync-queue-api-keys.sh
#   SKIP_PRODUCTION=1 ./scripts/sync-queue-api-keys.sh
#
# Notes:
# - Source of truth is local ASSISTANT_API_KEY.
# - Does NOT print secret values.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$REPO_ROOT/scripts/.env.assistant}"
WORKER_NAME="${WORKER_NAME:-orchestrator-hub}"
WORKER_URL_DEFAULT="https://orchestrator-hub.masa-stage1.workers.dev"
SKIP_PRODUCTION="${SKIP_PRODUCTION:-0}"

if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  set -a
  source "$ENV_FILE"
  set +a
fi

WORKERS_URL="${WORKERS_URL:-$WORKER_URL_DEFAULT}"
ASSISTANT_API_KEY="${ASSISTANT_API_KEY:-}"

if [ -z "$ASSISTANT_API_KEY" ]; then
  echo "ERROR: ASSISTANT_API_KEY is missing. Set it in $ENV_FILE or export ASSISTANT_API_KEY." >&2
  exit 2
fi

# Basic sanity check: we expect a 64-char hex string (openssl rand -hex 32).
if ! [[ "$ASSISTANT_API_KEY" =~ ^[0-9a-fA-F]{64}$ ]]; then
  echo "ERROR: ASSISTANT_API_KEY does not look like a 64-char hex string. Refusing to sync." >&2
  exit 2
fi

WRANGLER_BIN="$(command -v wrangler || true)"
if [ -z "$WRANGLER_BIN" ]; then
  # Fallback to project's local wrangler if available.
  if [ -x "$REPO_ROOT/node_modules/.bin/wrangler" ]; then
    WRANGLER_BIN="$REPO_ROOT/node_modules/.bin/wrangler"
  fi
fi
if [ -z "$WRANGLER_BIN" ]; then
  echo "ERROR: wrangler not found in PATH and no local node_modules bin available." >&2
  exit 2
fi

precheck() {
  curl -s -o /dev/null -w "%{http_code}" --max-time 10 \
    -H "X-API-Key: $ASSISTANT_API_KEY" \
    "$WORKERS_URL/api/queue" 2>/dev/null || echo "000"
}

HTTP_CODE="$(precheck)"
if [ "$HTTP_CODE" = "200" ]; then
  echo "OK: /api/queue auth already works (HTTP 200)."
  exit 0
fi

if [ "$HTTP_CODE" != "401" ]; then
  echo "ERROR: /api/queue check failed with HTTP $HTTP_CODE (not 401). Not syncing secrets." >&2
  echo "This likely indicates an outage or routing issue rather than key drift: $WORKERS_URL/api/queue" >&2
  exit 1
fi

echo "Detected /api/queue auth failure (HTTP 401). Syncing secrets to match local ASSISTANT_API_KEY..."

put_secret() {
  local name="$1"
  local env_name="$2" # "" (top-level) or "production"
  if [ -z "$env_name" ]; then
    # Use explicit empty env target to avoid accidental writes to the wrong environment.
    printf "%s" "$ASSISTANT_API_KEY" | "$WRANGLER_BIN" secret put "$name" --name "$WORKER_NAME" --env "" >/dev/null
  else
    printf "%s" "$ASSISTANT_API_KEY" | "$WRANGLER_BIN" secret put "$name" --name "$WORKER_NAME" --env "$env_name" >/dev/null
  fi
}

# Sync default (top-level) secrets.
put_secret "ASSISTANT_API_KEY" ""
put_secret "QUEUE_API_KEY" ""

if [ "$SKIP_PRODUCTION" != "1" ]; then
  put_secret "ASSISTANT_API_KEY" "production"
  put_secret "QUEUE_API_KEY" "production"
fi

HTTP_CODE_AFTER="$(precheck)"
if [ "$HTTP_CODE_AFTER" != "200" ]; then
  echo "ERROR: sync finished but /api/queue still fails (HTTP $HTTP_CODE_AFTER)." >&2
  echo "Check: Cloudflare deployment/env routing, Access settings, or that the correct Worker is at $WORKERS_URL." >&2
  exit 1
fi

echo "OK: synced QUEUE_API_KEY + ASSISTANT_API_KEY and verified /api/queue (HTTP 200)."
