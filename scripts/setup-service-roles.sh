#!/bin/bash
# Setup service role KV mappings for IDOR protection
# Usage: ./scripts/setup-service-roles.sh
#
# Requires: ADMIN_API_KEY and ASSISTANT_API_KEY environment variables
# These should match the Wrangler secrets configured for the worker.

set -euo pipefail

WORKER_URL="${WORKER_URL:-https://orchestrator-hub.masason.workers.dev}"

if [ -z "${ADMIN_API_KEY:-}" ]; then
  echo "ERROR: ADMIN_API_KEY is required"
  echo "Usage: ADMIN_API_KEY=xxx ASSISTANT_API_KEY=yyy ./scripts/setup-service-roles.sh"
  exit 1
fi

if [ -z "${ASSISTANT_API_KEY:-}" ]; then
  echo "ERROR: ASSISTANT_API_KEY is required"
  echo "Usage: ADMIN_API_KEY=xxx ASSISTANT_API_KEY=yyy ./scripts/setup-service-roles.sh"
  exit 1
fi

echo "=== Setting up service role KV mappings ==="
echo "Worker URL: $WORKER_URL"
echo ""

# 1. Register ASSISTANT_API_KEY as service role
echo "1/2: Registering ASSISTANT_API_KEY as service role..."
RESULT1=$(curl -s -w "\n%{http_code}" -X POST "$WORKER_URL/api/admin/apikey/mapping" \
  -H "X-API-Key: $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"apiKey\":\"$ASSISTANT_API_KEY\",\"userId\":\"system-daemon\",\"role\":\"service\"}")

HTTP_CODE1=$(echo "$RESULT1" | tail -1)
BODY1=$(echo "$RESULT1" | head -n -1)

if [ "$HTTP_CODE1" = "201" ]; then
  echo "   OK: ASSISTANT_API_KEY → service role (system-daemon)"
  echo "   Response: $BODY1"
else
  echo "   FAILED ($HTTP_CODE1): $BODY1"
fi
echo ""

# 2. Register ADMIN_API_KEY as service role
echo "2/2: Registering ADMIN_API_KEY as service role..."
RESULT2=$(curl -s -w "\n%{http_code}" -X POST "$WORKER_URL/api/admin/apikey/mapping" \
  -H "X-API-Key: $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"apiKey\":\"$ADMIN_API_KEY\",\"userId\":\"system-admin\",\"role\":\"service\"}")

HTTP_CODE2=$(echo "$RESULT2" | tail -1)
BODY2=$(echo "$RESULT2" | head -n -1)

if [ "$HTTP_CODE2" = "201" ]; then
  echo "   OK: ADMIN_API_KEY → service role (system-admin)"
  echo "   Response: $BODY2"
else
  echo "   FAILED ($HTTP_CODE2): $BODY2"
fi
echo ""

echo "=== Setup complete ==="
echo ""
echo "Verify by checking Memory API access:"
echo "  curl -H 'X-API-Key: \$ASSISTANT_API_KEY' $WORKER_URL/api/memory/context/test_user"
