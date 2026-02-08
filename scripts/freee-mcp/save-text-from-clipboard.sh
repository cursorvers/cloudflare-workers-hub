#!/usr/bin/env bash
set -euo pipefail

out="${1:-}"
if [[ -z "${out}" ]]; then
  echo "Usage: bash scripts/freee-mcp/save-text-from-clipboard.sh <outFile>" >&2
  exit 2
fi

if ! command -v pbpaste >/dev/null 2>&1; then
  echo "pbpaste not found (macOS required). Use: cat <file> | node scripts/freee-mcp/save-text.mjs <outFile>" >&2
  exit 1
fi

pbpaste | node scripts/freee-mcp/save-text.mjs "${out}"

