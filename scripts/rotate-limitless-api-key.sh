#!/bin/bash
set -euo pipefail

# Rotates the Limitless API key for the dedicated Limitless worker.
# This script intentionally does not accept the secret as an argument and does not echo it.

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

echo "Updating LIMITLESS_API_KEY for limitless-sync (wrangler-limitless.toml)..."
npx wrangler secret put LIMITLESS_API_KEY -c wrangler-limitless.toml

echo ""
echo "Optional: also update orchestrator-hub production (wrangler.toml)."
echo "Press Enter to skip, or type 'yes' to proceed:"
read -r ans
if [ "${ans:-}" = "yes" ]; then
  # Canonical worker is envless (orchestrator-hub). Canary is --env canary.
  npx wrangler secret put LIMITLESS_API_KEY -c wrangler.toml --env ""
fi

echo ""
echo "Done. Verify presence (values are not shown):"
echo "  npx wrangler secret list -c wrangler-limitless.toml"
