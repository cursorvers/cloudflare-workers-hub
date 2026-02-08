#!/bin/bash
set -euo pipefail

# Smoke test for:
# - Cloudflare Worker (limitless-sync) health
# - Supabase connectivity (processed_lifelogs)
# - Local Obsidian sync runner
#
# Notes:
# - Uses SUPABASE service role key from .env.local (local machine only).
# - Does not print secrets.

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

WORKER_HEALTH_URL="${WORKER_HEALTH_URL:-https://limitless-sync.masa-stage1.workers.dev/health}"

ENV_FILE="$ROOT_DIR/.env.local"
if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: .env.local not found at $ENV_FILE" >&2
  exit 1
fi

while IFS='=' read -r key value; do
  case "$key" in
    SUPABASE_URL|SUPABASE_SERVICE_ROLE_KEY)
      export "$key=$value"
      ;;
  esac
done < <(grep -E "^(SUPABASE_URL|SUPABASE_SERVICE_ROLE_KEY)=" "$ENV_FILE" || true)

if [ -z "${SUPABASE_URL:-}" ] || [ -z "${SUPABASE_SERVICE_ROLE_KEY:-}" ]; then
  echo "ERROR: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set in .env.local" >&2
  exit 1
fi

echo "[1/4] Worker health..."
curl -fsS "$WORKER_HEALTH_URL" >/dev/null
echo "  OK"

supabase_get() {
  local path="$1"
  curl -fsS \
    -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
    -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
    "$SUPABASE_URL/rest/v1/$path"
}

echo "[2/4] Supabase status..."
latest_updated_at="$(
  supabase_get "processed_lifelogs?select=updated_at&order=updated_at.desc&limit=1" | jq -r '.[0].updated_at // ""'
)"
unsynced_count="$(
  supabase_get "processed_lifelogs?select=count&obsidian_synced=eq.false" | jq -r '.[0].count // 0'
)"
echo "  latest updated_at: ${latest_updated_at:-unknown}"
echo "  obsidian unsynced: ${unsynced_count}"

echo "[3/4] Obsidian sync runner..."
"$ROOT_DIR/scripts/obsidian-sync-runner.sh"
echo "  OK (see logs/obsidian-sync.log)"

echo "[4/4] Supabase re-check..."
unsynced_after="$(
  supabase_get "processed_lifelogs?select=count&obsidian_synced=eq.false" | jq -r '.[0].count // 0'
)"
echo "  obsidian unsynced (after): ${unsynced_after}"

echo "Smoke test complete."

