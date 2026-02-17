#!/usr/bin/env bash
# Backfill Limitless lifelogs day-by-day via Worker endpoint.
#
# Usage:
#   LIMITLESS_SYNC_KEY=xxx ./scripts/backfill-limitless.sh [START_DATE] [END_DATE]
#
# Defaults: 2026-01-29 to today (the gap period identified in Issue #36/#38).
# Each day is processed as a separate HTTP call with pagination.
# Supabase upsert on limitless_id guarantees idempotency — safe to re-run.

set -euo pipefail

WORKER_URL="${WORKER_URL:-https://limitless-sync.masa-stage1.workers.dev}"
API_KEY="${LIMITLESS_SYNC_KEY:-}"
START_DATE="${1:-2026-01-29}"
END_DATE="${2:-$(date +%Y-%m-%d)}"
PAGE_SIZE="${PAGE_SIZE:-5}"
MAX_PAGES="${MAX_PAGES:-10}"
SLEEP_BETWEEN="${SLEEP_BETWEEN:-2}"

if [ -z "$API_KEY" ]; then
  echo "ERROR: LIMITLESS_SYNC_KEY env var is required" >&2
  exit 1
fi

echo "=== Limitless Backfill ==="
echo "Worker:     $WORKER_URL"
echo "Range:      $START_DATE -> $END_DATE"
echo "Page size:  $PAGE_SIZE, Max pages: $MAX_PAGES"
echo "Delay:      ${SLEEP_BETWEEN}s between days"
echo ""

CURRENT="$START_DATE"
TOTAL_SYNCED=0
TOTAL_ERRORS=0

while [[ "$CURRENT" < "$END_DATE" || "$CURRENT" == "$END_DATE" ]]; do
  # Day boundaries in ISO 8601
  DAY_START="${CURRENT}T00:00:00Z"
  DAY_END="${CURRENT}T23:59:59Z"

  echo -n "[$CURRENT] Syncing... "

  CURSOR=""
  DAY_SYNCED=0
  DAY_DONE=false

  while [ "$DAY_DONE" = "false" ]; do
    # Build request body
    if [ -n "$CURSOR" ]; then
      BODY=$(printf '{"startTime":"%s","endTime":"%s","cursor":"%s","pageSize":%d,"maxPages":%d}' \
        "$DAY_START" "$DAY_END" "$CURSOR" "$PAGE_SIZE" "$MAX_PAGES")
    else
      BODY=$(printf '{"startTime":"%s","endTime":"%s","pageSize":%d,"maxPages":%d}' \
        "$DAY_START" "$DAY_END" "$PAGE_SIZE" "$MAX_PAGES")
    fi

    RESP=$(curl -sS -X POST "${WORKER_URL}/api/limitless/backfill" \
      -H "Authorization: Bearer $API_KEY" \
      -H "Content-Type: application/json" \
      -d "$BODY" 2>&1) || true

    # Parse response
    SYNCED=$(echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('synced',0))" 2>/dev/null || echo 0)
    ERRORS=$(echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('errors',[])))" 2>/dev/null || echo 0)
    DONE=$(echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(str(d.get('done',True)).lower())" 2>/dev/null || echo "true")
    NEXT_CURSOR=$(echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('nextCursor',''))" 2>/dev/null || echo "")

    DAY_SYNCED=$((DAY_SYNCED + SYNCED))
    TOTAL_ERRORS=$((TOTAL_ERRORS + ERRORS))

    if [ "$DONE" = "true" ] || [ -z "$NEXT_CURSOR" ]; then
      DAY_DONE=true
    else
      CURSOR="$NEXT_CURSOR"
      sleep 1
    fi
  done

  TOTAL_SYNCED=$((TOTAL_SYNCED + DAY_SYNCED))
  echo "synced=$DAY_SYNCED"

  # Advance to next day
  if date -v +1d >/dev/null 2>&1; then
    CURRENT=$(date -j -f "%Y-%m-%d" "$CURRENT" -v +1d +%Y-%m-%d)
  else
    CURRENT=$(date -d "$CURRENT + 1 day" +%Y-%m-%d)
  fi

  sleep "$SLEEP_BETWEEN"
done

echo ""
echo "=== Backfill Complete ==="
echo "Total synced: $TOTAL_SYNCED"
echo "Total errors: $TOTAL_ERRORS"
