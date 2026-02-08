#!/bin/bash
# Obsidian Sync Runner
# Runs obsidian-sync.ts with env vars from .env.local
# Designed for launchd periodic execution

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
LOG_DIR="$PROJECT_DIR/logs"
LOG_FILE="$LOG_DIR/obsidian-sync.log"
LOCK_DIR="$LOG_DIR/obsidian-sync.lock"

# Ensure log directory exists
mkdir -p "$LOG_DIR"

# Simple non-overlapping guard (launchd can re-trigger while a run is in progress).
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  exit 0
fi
cleanup() { rmdir "$LOCK_DIR" 2>/dev/null || true; }
trap cleanup EXIT

# Rotate log if > 1MB
if [ -f "$LOG_FILE" ] && [ "$(stat -f%z "$LOG_FILE" 2>/dev/null || echo 0)" -gt 1048576 ]; then
  mv "$LOG_FILE" "$LOG_FILE.old"
fi

{
  echo "=== $(date '+%Y-%m-%d %H:%M:%S') Obsidian Sync Start ==="

  # Load env vars
  ENV_FILE="$PROJECT_DIR/.env.local"
  if [ ! -f "$ENV_FILE" ]; then
    echo "ERROR: .env.local not found at $ENV_FILE"
    exit 1
  fi

  # Robustly parse SUPABASE_* lines (service role keys often contain '=' padding).
  while IFS='=' read -r key value; do
    case "$key" in
      SUPABASE_URL|SUPABASE_SERVICE_ROLE_KEY)
        export "$key=$value"
        ;;
    esac
  done < <(grep -E "^(SUPABASE_URL|SUPABASE_SERVICE_ROLE_KEY)=" "$ENV_FILE" || true)

  if [ -z "${SUPABASE_URL:-}" ] || [ -z "${SUPABASE_SERVICE_ROLE_KEY:-}" ]; then
    echo "ERROR: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set"
    exit 1
  fi

  # Ensure node is available (nvm / Homebrew / system)
  for node_dir in \
    "$HOME/.nvm/versions/node"/*/bin \
    /opt/homebrew/bin \
    /usr/local/bin; do
    [ -d "$node_dir" ] && export PATH="$node_dir:$PATH"
  done

  # Run sync
  cd "$PROJECT_DIR"
  node scripts/obsidian-sync.ts 2>&1

  echo "=== $(date '+%Y-%m-%d %H:%M:%S') Obsidian Sync End ==="
  echo ""
} >> "$LOG_FILE" 2>&1
