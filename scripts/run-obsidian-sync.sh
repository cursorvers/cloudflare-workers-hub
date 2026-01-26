#!/bin/bash
# Obsidian Sync - launchd wrapper
# Loads .env.local and runs obsidian-sync.ts

set -euo pipefail

# launchd uses minimal PATH — set NVM paths explicitly
export PATH="/Users/masayuki/.nvm/versions/node/v22.19.0/bin:/Users/masayuki/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
LOG_FILE="$PROJECT_DIR/logs/obsidian-sync.log"

mkdir -p "$PROJECT_DIR/logs"

{
  echo "=== $(date '+%Y-%m-%d %H:%M:%S') ==="

  # Load environment
  if [ -f "$PROJECT_DIR/.env.local" ]; then
    export $(grep -v '^#' "$PROJECT_DIR/.env.local" | xargs)
  else
    echo "ERROR: .env.local not found"
    exit 1
  fi

  # Run sync
  cd "$PROJECT_DIR"
  npx tsx scripts/obsidian-sync.ts

  echo "=== Done ==="
  echo ""
} >> "$LOG_FILE" 2>&1
