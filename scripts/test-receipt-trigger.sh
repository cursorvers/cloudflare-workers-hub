#!/bin/bash
# Web Receipt Scraper Manual Trigger Test Script

set -e

# Configuration
WORKER_URL="${WORKER_URL:-https://orchestrator-hub.masa-stage1.workers.dev}"
RECEIPTS_API_KEY="${RECEIPTS_API_KEY}"
SOURCE_ID="${1:-stripe}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "======================================"
echo "Web Receipt Scraper Trigger Test"
echo "======================================"
echo ""
echo "Worker URL: $WORKER_URL"
echo "Source ID: $SOURCE_ID"
echo ""

# Check API key
if [ -z "$RECEIPTS_API_KEY" ]; then
  echo -e "${RED}Error: RECEIPTS_API_KEY environment variable not set${NC}"
  echo "Usage: RECEIPTS_API_KEY=your-key ./test-receipt-trigger.sh [source-id]"
  exit 1
fi

# Test 1: List all sources
echo "Test 1: List all sources"
echo "------------------------"
response=$(curl -s -w "\n%{http_code}" \
  -H "Authorization: Bearer $RECEIPTS_API_KEY" \
  "$WORKER_URL/api/receipts/sources")

http_code=$(echo "$response" | tail -n1)
body=$(echo "$response" | sed '$d')

if [ "$http_code" = "200" ]; then
  echo -e "${GREEN}✓ List sources successful${NC}"
  echo "$body" | jq '.'
else
  echo -e "${RED}✗ List sources failed (HTTP $http_code)${NC}"
  echo "$body"
  exit 1
fi

echo ""

# Test 2: Get source details
echo "Test 2: Get source details ($SOURCE_ID)"
echo "----------------------------------------"
response=$(curl -s -w "\n%{http_code}" \
  -H "Authorization: Bearer $RECEIPTS_API_KEY" \
  "$WORKER_URL/api/receipts/sources/$SOURCE_ID")

http_code=$(echo "$response" | tail -n1)
body=$(echo "$response" | sed '$d')

if [ "$http_code" = "200" ]; then
  echo -e "${GREEN}✓ Get source successful${NC}"
  echo "$body" | jq '.'
else
  echo -e "${RED}✗ Get source failed (HTTP $http_code)${NC}"
  echo "$body"
  exit 1
fi

echo ""

# Test 3: Trigger scraping
echo "Test 3: Trigger scraping ($SOURCE_ID)"
echo "--------------------------------------"
response=$(curl -s -w "\n%{http_code}" \
  -X POST \
  -H "Authorization: Bearer $RECEIPTS_API_KEY" \
  -H "Content-Type: application/json" \
  "$WORKER_URL/api/receipts/sources/$SOURCE_ID/trigger")

http_code=$(echo "$response" | tail -n1)
body=$(echo "$response" | sed '$d')

if [ "$http_code" = "202" ]; then
  echo -e "${GREEN}✓ Trigger successful (HTTP 202 Accepted)${NC}"
  echo "$body" | jq '.'

  log_id=$(echo "$body" | jq -r '.logId')
  echo ""
  echo -e "${YELLOW}Log ID: $log_id${NC}"
  echo "Check GitHub Actions: https://github.com/cursorvers/cloudflare-workers-hub/actions"

elif [ "$http_code" = "503" ]; then
  echo -e "${YELLOW}⚠ Trigger not configured (HTTP 503)${NC}"
  echo "$body" | jq '.'
  echo ""
  echo "This is expected if GITHUB_TOKEN is not set."
  echo "Please set GITHUB_TOKEN in Cloudflare Workers secrets."

else
  echo -e "${RED}✗ Trigger failed (HTTP $http_code)${NC}"
  echo "$body"
  exit 1
fi

echo ""
echo "======================================"
echo "Test completed"
echo "======================================"
