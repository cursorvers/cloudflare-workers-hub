#!/usr/bin/env bash
set -euo pipefail

# Accident-proof deploy helper:
# - Forces D1 migrations to remote (never local by mistake)
# - Deploys the intended Workers script (envless or --env canary)
# - Runs a minimal health check
#
# Usage:
#   bash scripts/release-worker.sh hub
#   bash scripts/release-worker.sh canary
#   # Opt-in: apply D1 migrations when releasing canary (affects shared production DB!)
#   bash scripts/release-worker.sh canary --apply-migrations

TARGET="${1:-}"
APPLY_MIGRATIONS="${2:-}"

case "${TARGET}" in
  hub)
    ENV_NAME=""
    WORKER_URL="https://orchestrator-hub.masa-stage1.workers.dev"
    APPLY_MIGRATIONS="--apply-migrations"
    ;;
  canary)
    ENV_NAME="canary"
    WORKER_URL="https://orchestrator-hub-canary.masa-stage1.workers.dev"
    ;;
  hub-production)
    # Backward compatible alias: the former "production" env was renamed to "canary".
    # This DOES NOT deploy to orchestrator-hub-production anymore.
    echo "[release] WARNING: target 'hub-production' is deprecated; mapping to 'canary'." >&2
    ENV_NAME="canary"
    WORKER_URL="https://orchestrator-hub-canary.masa-stage1.workers.dev"
    ;;
  *)
    echo "Usage: bash scripts/release-worker.sh <hub|canary>" >&2
    exit 2
    ;;
esac

retry() {
  local n=0
  local max=3
  local delay=2
  until "$@"; do
    n=$((n + 1))
    if [[ "$n" -ge "$max" ]]; then
      return 1
    fi
    sleep "$delay"
    delay=$((delay * 2))
  done
}

echo "[release] target=${TARGET}"
if [[ "${APPLY_MIGRATIONS}" == "--apply-migrations" ]]; then
  echo "[release] applying D1 migrations (remote) ..."
  if [[ -n "${ENV_NAME}" ]]; then
    retry npx --yes wrangler d1 migrations apply DB --env "${ENV_NAME}" --remote
  else
    # Wrangler warns when multiple envs exist; `--env=` explicitly targets top-level (hub/envless).
    retry npx --yes wrangler d1 migrations apply DB --env= --remote
  fi
else
  if [[ -n "${ENV_NAME}" ]]; then
    echo "[release] NOTE: skipping D1 migrations for canary (shared DB safety). To apply, pass --apply-migrations." >&2
  else
    echo "[release] NOTE: skipping D1 migrations (unexpected for hub). To apply, pass --apply-migrations." >&2
  fi
fi

echo "[release] deploying worker ..."
if [[ -n "${ENV_NAME}" ]]; then
  retry npx --yes wrangler deploy --env "${ENV_NAME}"
else
  retry npx --yes wrangler deploy --env=
fi

echo "[release] health check: ${WORKER_URL}/health"
status="$(curl -sS -o /dev/null -w "%{http_code}" "${WORKER_URL}/health" || true)"
case "${status}" in
  200|204|301|302|307|308|401|403)
    echo "[release] ok (health status=${status})"
    ;;
  *)
    echo "[release] health check failed (status=${status})" >&2
    exit 1
    ;;
esac
