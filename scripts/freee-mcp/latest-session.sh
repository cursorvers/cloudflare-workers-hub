#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
base="${root_dir}/logs/freee-mcp"

if [[ ! -d "${base}" ]]; then
  echo "No freee-mcp logs directory found: ${base}" >&2
  exit 1
fi

# Find newest session directory using lexicographic ordering:
# - date folders are YYYY-MM-DD
# - session folders are HHMMSS_slug
latest="$(
  find "${base}" -mindepth 2 -maxdepth 2 -type d 2>/dev/null \
    | sort \
    | tail -n 1
)"

if [[ -z "${latest}" ]]; then
  echo "No sessions found under: ${base}" >&2
  exit 1
fi

printf '%s\n' "${latest}"

