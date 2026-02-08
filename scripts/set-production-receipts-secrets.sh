#!/usr/bin/env bash
set -euo pipefail

# Set production secrets required for Gmail receipt polling + freee upload.
#
# Usage:
#   export GMAIL_CLIENT_ID=...
#   export GMAIL_CLIENT_SECRET=...
#   export GMAIL_REFRESH_TOKEN=...
#   export FREEE_CLIENT_ID=...
#   export FREEE_CLIENT_SECRET=...
#   export FREEE_COMPANY_ID=...        # optional (auto-resolved from /companies and stored in D1)
#   export FREEE_REDIRECT_URI=...
#   export FREEE_ENCRYPTION_KEY=...
#   # Optional:
#   export ADMIN_API_KEY=...
#   export MONITORING_API_KEY=...
#
#   bash scripts/set-production-receipts-secrets.sh
#
# Targeting:
# - Default (recommended): set secrets on envless script (`orchestrator-hub`)
# - To target canary (`orchestrator-hub-canary`): pass `--env canary`
#
# Notes:
# - Values are piped via stdin to avoid showing them in the terminal history.
# - This script never echoes secret values.

cd "$(dirname "$0")/.."

WRANGLER_ENV_FLAG=(--env=)
if [[ "${1:-}" == "--env" && "${2:-}" == "canary" ]]; then
  WRANGLER_ENV_FLAG=(--env canary)
elif [[ "${1:-}" == "--env" && "${2:-}" == "production" ]]; then
  echo "WARNING: '--env production' is deprecated; use '--env canary'." >&2
  WRANGLER_ENV_FLAG=(--env canary)
fi

load_env_file() {
  local file="$1"
  if [[ -f "$file" ]]; then
    # .env / .dev.vars are typically KEY=VALUE files; try to load them as shell.
    # If a file isn't shell-compatible, keep using exported env vars instead.
    set -a
    # shellcheck disable=SC1090
    if ! source "$file" >/dev/null 2>&1; then
      set +a
      echo "Warning: failed to load $file (not shell-compatible). Using current environment only." >&2
      return 0
    fi
    set +a
  fi
}

load_env_file ".env"
load_env_file ".dev.vars"
load_env_file ".dev.vars.backup"

require() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "Missing required env var: ${name}" >&2
    exit 2
  fi
}

put_secret() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    return 0
  fi
  if [[ "${DRY_RUN:-}" == "1" ]]; then
    echo "Would set secret: ${name}"
    return 0
  fi
  printf "%s" "${!name}" | npx wrangler secret put "${name}" "${WRANGLER_ENV_FLAG[@]}" >/dev/null
  echo "Set secret: ${name}"
}

require GMAIL_CLIENT_ID
require GMAIL_CLIENT_SECRET
require GMAIL_REFRESH_TOKEN
require FREEE_CLIENT_ID
require FREEE_CLIENT_SECRET
require FREEE_REDIRECT_URI
require FREEE_ENCRYPTION_KEY

put_secret GMAIL_CLIENT_ID
put_secret GMAIL_CLIENT_SECRET
put_secret GMAIL_REFRESH_TOKEN
put_secret FREEE_CLIENT_ID
put_secret FREEE_CLIENT_SECRET
put_secret FREEE_COMPANY_ID
put_secret FREEE_REDIRECT_URI
put_secret FREEE_ENCRYPTION_KEY

# Optional (recommended) keys
put_secret ADMIN_API_KEY
put_secret MONITORING_API_KEY

echo "Done."
