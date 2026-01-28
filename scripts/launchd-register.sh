#!/bin/bash
# launchd-register.sh — Idempotent launchd agent registration with deduplication
#
# Usage:
#   ./scripts/launchd-register.sh [--unregister]
#
# Features:
#   - Scans LaunchAgents for duplicate obsidian-sync agents
#   - Unloads and removes all non-canonical duplicates
#   - Generates plist from single source of truth (this file)
#   - Idempotent: safe to run multiple times
#
# Canonical label: com.cloudflare-workers-hub.obsidian-sync

set -euo pipefail

# ============================================================
# Configuration (Single Source of Truth)
# ============================================================
CANONICAL_LABEL="com.cloudflare-workers-hub.obsidian-sync"
SERVICE_KEYWORD="obsidian-sync"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
RUNNER_SCRIPT="$SCRIPT_DIR/obsidian-sync-runner.sh"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
CANONICAL_PLIST="$LAUNCH_AGENTS_DIR/$CANONICAL_LABEL.plist"
LOG_DIR="$PROJECT_DIR/logs"

# Schedule: every hour at minute 5
SCHEDULE_MINUTE=5

# ============================================================
# Functions
# ============================================================

log() { echo "[launchd-register] $*"; }

find_duplicates() {
  local found=()
  for plist in "$LAUNCH_AGENTS_DIR"/*.plist; do
    [ -f "$plist" ] || continue
    local label
    label=$(/usr/libexec/PlistBuddy -c "Print :Label" "$plist" 2>/dev/null || true)
    if [[ "$label" == *"$SERVICE_KEYWORD"* && "$label" != "$CANONICAL_LABEL" ]]; then
      found+=("$plist")
    fi
  done
  echo "${found[@]:-}"
}

unload_agent() {
  local plist="$1"
  local label
  label=$(/usr/libexec/PlistBuddy -c "Print :Label" "$plist" 2>/dev/null || true)
  if [ -n "$label" ] && launchctl list "$label" &>/dev/null; then
    log "Unloading: $label"
    launchctl bootout "gui/$(id -u)" "$plist" 2>/dev/null || true
  fi
}

remove_duplicates() {
  local duplicates
  duplicates=$(find_duplicates)
  if [ -z "$duplicates" ]; then
    log "No duplicates found."
    return
  fi
  for plist in $duplicates; do
    local label
    label=$(/usr/libexec/PlistBuddy -c "Print :Label" "$plist" 2>/dev/null || true)
    log "Removing duplicate: $label ($plist)"
    unload_agent "$plist"
    rm -f "$plist"
  done
}

generate_plist() {
  mkdir -p "$LAUNCH_AGENTS_DIR"
  cat > "$CANONICAL_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${CANONICAL_LABEL}</string>
	<key>ProgramArguments</key>
	<array>
		<string>/bin/bash</string>
		<string>${RUNNER_SCRIPT}</string>
	</array>
	<key>StartCalendarInterval</key>
	<dict>
		<key>Minute</key>
		<integer>${SCHEDULE_MINUTE}</integer>
	</dict>
	<key>StandardOutPath</key>
	<string>${LOG_DIR}/obsidian-sync-launchd.log</string>
	<key>StandardErrorPath</key>
	<string>${LOG_DIR}/obsidian-sync-launchd.log</string>
	<key>RunAtLoad</key>
	<false/>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key>
		<string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
	</dict>
</dict>
</plist>
PLIST
  log "Generated plist: $CANONICAL_PLIST"
}

load_agent() {
  # Unload if already loaded
  if launchctl list "$CANONICAL_LABEL" &>/dev/null; then
    log "Unloading existing canonical agent..."
    launchctl bootout "gui/$(id -u)" "$CANONICAL_PLIST" 2>/dev/null || true
    sleep 1
  fi
  launchctl load "$CANONICAL_PLIST"
  log "Loaded: $CANONICAL_LABEL"
}

verify() {
  if launchctl list "$CANONICAL_LABEL" &>/dev/null; then
    log "Verified: $CANONICAL_LABEL is active"
  else
    log "ERROR: $CANONICAL_LABEL failed to load"
    exit 1
  fi

  # Final duplicate check
  local remaining
  remaining=$(find_duplicates)
  if [ -n "$remaining" ]; then
    log "WARNING: Duplicates still exist: $remaining"
    exit 1
  fi
  log "No duplicates detected."
}

unregister() {
  log "Unregistering $CANONICAL_LABEL..."
  if [ -f "$CANONICAL_PLIST" ]; then
    unload_agent "$CANONICAL_PLIST"
    rm -f "$CANONICAL_PLIST"
    log "Removed: $CANONICAL_PLIST"
  else
    log "Plist not found, nothing to remove."
  fi
  remove_duplicates
  log "Unregister complete."
}

# ============================================================
# Main
# ============================================================

if [[ "${1:-}" == "--unregister" ]]; then
  unregister
  exit 0
fi

log "=== Starting idempotent registration ==="

# Step 1: Remove duplicates
remove_duplicates

# Step 2: Generate canonical plist
generate_plist

# Step 3: Validate plist
plutil -lint "$CANONICAL_PLIST" || { log "ERROR: Invalid plist"; exit 1; }

# Step 4: Load agent
load_agent

# Step 5: Verify
verify

log "=== Registration complete ==="
