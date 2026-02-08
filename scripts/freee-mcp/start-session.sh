#!/usr/bin/env bash
set -euo pipefail

slug="${1:-freee-mcp-session}"
root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

session_dir="$(bash "${root_dir}/scripts/freee-mcp/new-session.sh" "${slug}")"

printf '\n%s\n' "Session: ${session_dir}"
printf '%s\n' "Next:"
printf '%s\n' "- Paste the contents of: ${session_dir}/00_prompt_readonly.txt into Claude (freee-mcp session)"
printf '%s\n' "- Record tool calls in: ${session_dir}/20_queries.md"
printf '%s\n' "- Save results under: ${session_dir}/30_results/"
printf '%s\n' "- Use templates: docs/FREEE_MCP_INCIDENT_TEMPLATES.md"
printf '%s\n\n' "- Choose endpoints: docs/FREEE_MCP_PATH_DISCOVERY.md"
printf '%s\n\n' "- Default: docs/FREEE_MCP_EXPENSE_PLAYBOOK.md"
