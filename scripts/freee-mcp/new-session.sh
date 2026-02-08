#!/usr/bin/env bash
set -euo pipefail

slug="${1:-freee-mcp-session}"
slug="$(printf '%s' "$slug" | tr '[:space:]' '-' | tr -cd '[:alnum:]-_.' | sed 's/--*/-/g')"

date_dir="$(date +%F)"
time_dir="$(date +%H%M%S)"
root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
templates_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
session_dir="${root_dir}/logs/freee-mcp/${date_dir}/${time_dir}_${slug}"

mkdir -p "${session_dir}/30_results" "${session_dir}/40_changes"

cat > "${session_dir}/30_results/README.txt" <<'EOF'
Evidence files (recommended naming):

- candidates.json
  Raw list response from freee (GET). Used for local filtering / grouping.

- paths.json / paths.txt
  Output from freee_api_list_paths. Use local filtering to pick endpoints.

- details_<id>.json
  Raw detail response for a specific record ID (GET).

How to save JSON safely:

- From clipboard (macOS):
  bash scripts/freee-mcp/save-json-from-clipboard.sh <thisDir>/30_results/candidates.json

- From a file:
  cat response.json | node scripts/freee-mcp/save-json.mjs <thisDir>/30_results/candidates.json

How to save plain text (paths, notes):

- From clipboard (macOS):
  bash scripts/freee-mcp/save-text-from-clipboard.sh <thisDir>/30_results/paths.txt

- From a file:
  cat paths.txt | node scripts/freee-mcp/save-text.mjs <thisDir>/30_results/paths.txt
EOF

cat > "${session_dir}/40_changes/README.txt" <<'EOF'
Change artifacts:

- WRITE_APPROVAL.md (required before any write calls)
- duplicate_groups.json (output from group-duplicates.mjs)
- misclassification_report.json (output from analyze-misclassification.mjs)
- not_found_matches.json (output from triage-not-found.mjs)
EOF

cat > "${session_dir}/40_changes/not_found_query.json" <<'EOF'
{
  "date": "YYYY-MM-DD",
  "amount": "",
  "partner": "",
  "contains": "",
  "array": null,
  "limit": 50
}
EOF

cat > "${session_dir}/40_changes/correct.json" <<'EOF'
[]
EOF

cat > "${session_dir}/40_changes/incorrect.json" <<'EOF'
[]
EOF

cat > "${session_dir}/README.txt" <<'EOF'
freee-mcp operator session folder.

Non-negotiable start:
- freee_auth_status
- freee_get_current_company

Default: READ-ONLY (no post/put/patch/delete).
If write is required:
- enumerate exact IDs
- fetch "before" state
- draft payload
- ask for explicit approval
- write one-by-one
- fetch "after" state
EOF

cat > "${session_dir}/10_plan.md" <<'EOF'
# Plan

- Goal:
- Scope:
- Company (expected):
- Read-only confirmation steps:
- If write needed (why, rollback):
EOF

cat > "${session_dir}/20_queries.md" <<'EOF'
# Queries / Tool Calls

Record the exact MCP tool calls executed, in order.

Recommended format:

- tool: freee_api_get
  path: /api/1/...
  params: {...}
  saved_as: 30_results/candidates.json
EOF

cat > "${session_dir}/00_playbook.md" <<'EOF'
# Session Playbook (Read-Only Default)

Non-negotiable start:

1. freee_auth_status
2. freee_get_current_company

Then:

1. If endpoint is unclear:
   - freee_api_list_paths
   - Save output as `30_results/paths.txt` (plain text) or `30_results/paths.json`
   - Filter locally:
     - `node scripts/freee-mcp/filter-paths.mjs <pathsFile> --query deals`
2. Run the smallest possible list GET (1 day window) and save raw JSON as:
   - `30_results/candidates.json`
3. Narrow locally (no API calls):
   - Not Found: `node scripts/freee-mcp/find-candidates.mjs 30_results/candidates.json --date ... --amount ... --contains ...`
   - Duplicates: `node scripts/freee-mcp/group-duplicates.mjs 30_results/candidates.json --key "date|amount|partner_id" --out 40_changes/duplicate_groups.json`
   - Misclassification: save correct/incorrect example sets and run:
     - `node scripts/freee-mcp/analyze-misclassification.mjs correct.json incorrect.json --out 40_changes/misclassification_report.json`
4. Only after IDs are stable:
   - fetch details with freee_api_get and save as `30_results/details_<id>.json`

Write Mode (exception):

- Fill `40_changes/WRITE_APPROVAL.md` before calling any write tool.
EOF

if [[ -f "${templates_dir}/prompt-readonly.txt" ]]; then
  cp "${templates_dir}/prompt-readonly.txt" "${session_dir}/00_prompt_readonly.txt"
fi

if [[ -f "${templates_dir}/write-approval-template.md" ]]; then
  cp "${templates_dir}/write-approval-template.md" "${session_dir}/40_changes/WRITE_APPROVAL.md"
fi

printf '%s\n' "${session_dir}"
