#!/bin/bash
# Test script for Daemon Health API
# Usage: ./test-daemon-api.sh <ADMIN_API_KEY> <WORKERS_URL>

set -e

ADMIN_API_KEY="${1:-test-key}"
WORKERS_URL="${2:-http://localhost:8787}"

echo "🧪 Testing Daemon Health API"
echo "================================"
echo ""

# Test 1: Register daemon
echo "📝 Test 1: Register daemon"
REGISTER_RESPONSE=$(curl -s -X POST "${WORKERS_URL}/api/daemon/register" \
  -H "X-API-Key: ${ADMIN_API_KEY}" \
  -H "Content-Type: application/json" \
  -d "{
    \"daemonId\": \"daemon_test_1\",
    \"version\": \"2.2\",
    \"capabilities\": [\"queue\", \"cron\"],
    \"pollInterval\": 5000,
    \"registeredAt\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"
  }")

echo "Response: ${REGISTER_RESPONSE}"
echo ""

# Test 2: Send heartbeat
echo "💓 Test 2: Send heartbeat"
HEARTBEAT_RESPONSE=$(curl -s -X POST "${WORKERS_URL}/api/daemon/heartbeat" \
  -H "X-API-Key: ${ADMIN_API_KEY}" \
  -H "Content-Type: application/json" \
  -d "{
    \"daemonId\": \"daemon_test_1\",
    \"status\": \"healthy\",
    \"tasksProcessed\": 42,
    \"currentTask\": \"evt_test_123\",
    \"lastHeartbeat\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"
  }")

echo "Response: ${HEARTBEAT_RESPONSE}"
echo ""

# Test 3: Check health
echo "🏥 Test 3: Check daemon health"
HEALTH_RESPONSE=$(curl -s -X GET "${WORKERS_URL}/api/daemon/health" \
  -H "X-API-Key: ${ADMIN_API_KEY}")

echo "Response: ${HEALTH_RESPONSE}"
echo ""

# Test 4: Unauthorized access (no API key)
echo "🔒 Test 4: Unauthorized access (should fail)"
UNAUTH_RESPONSE=$(curl -s -X GET "${WORKERS_URL}/api/daemon/health")

echo "Response: ${UNAUTH_RESPONSE}"
echo ""

# Test 5: Heartbeat for unregistered daemon (should fail)
echo "❌ Test 5: Heartbeat for unregistered daemon (should fail)"
UNREGISTERED_RESPONSE=$(curl -s -X POST "${WORKERS_URL}/api/daemon/heartbeat" \
  -H "X-API-Key: ${ADMIN_API_KEY}" \
  -H "Content-Type: application/json" \
  -d "{
    \"daemonId\": \"daemon_nonexistent\",
    \"status\": \"healthy\",
    \"tasksProcessed\": 0,
    \"lastHeartbeat\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"
  }")

echo "Response: ${UNREGISTERED_RESPONSE}"
echo ""

echo "✅ All tests completed!"
