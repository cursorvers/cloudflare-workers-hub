# freee-mcp Incident Templates (Read-Only First)

These templates are designed to keep you out of dead ends and prevent accidental data changes.

Rule: run `freee_auth_status` and `freee_get_current_company` first, every time.

If you cannot identify stable record IDs, stop and do not attempt write operations.

## Start Here (Recommended)

Create a session folder (evidence + templates):

```bash
bash scripts/freee-mcp/start-session.sh "incident-short-title"
```

Then paste `00_prompt_readonly.txt` from the created folder into Claude.

## Template 1: "Receipt/Deal Not Found in freee"

Goal: confirm whether the record exists, and if not, narrow down where the pipeline broke.

Steps:

1. Confirm auth + company.
2. Use `freee_api_list_paths` to find the relevant endpoints.
   - See also: `docs/FREEE_MCP_PATH_DISCOVERY.md` (keywords + selection heuristics)
3. Use `freee_api_get` to list candidates by a tight time window (day-level), then narrow by:
   - amount
   - partner name
   - memo/description
4. If still not found:
   - expand the time window
   - verify you are in the correct company again
5. Capture evidence:
   - the list query
   - the closest candidates
   - the conclusion ("missing" vs "exists with different fields")

Artifacts:

- `20_queries.md`: the exact `freee_api_get` calls used
- `30_results/`: JSON or summarized results (save the raw response as `candidates.json` if possible)

Local narrowing (optional, read-only):

```bash
node scripts/freee-mcp/find-candidates.mjs <sessionDir>/30_results/candidates.json --date <YYYY-MM-DD> --amount <number> --contains "<merchant>"
```

## Template 2: "Duplicates Suspected"

Goal: enumerate duplicates as stable IDs and quantify impact.

Steps:

1. Confirm auth + company.
2. Pull a candidate list for the smallest timeframe that still shows the issue (start with 1 day).
3. Save the raw list response as JSON under `30_results/candidates.json`.
4. Group candidates by a deterministic key, such as:
   - date (YYYY-MM-DD)
   - amount
   - partner_id (if present)
5. Produce a plain list of IDs per duplicate group.
6. Pull details for each ID with `freee_api_get` to confirm they are truly duplicates.

Recommended (scripted) grouping (read-only, no API writes):

```bash
node scripts/freee-mcp/group-duplicates.mjs <sessionDir>/30_results/candidates.json --key "date|amount|partner_id" --out <sessionDir>/40_changes/duplicate_groups.json
```

Notes:

- If your response array is nested or the array field isn't auto-detected, use `--array <field>` (e.g. `--array deals`).
- If your API uses different field names (e.g. `issue_date`, `total_amount`), adjust `--key`.

Decision:

- If duplicates are systematic: fix production idempotency keys, do not manually delete in bulk.
- If it is a small one-off: proceed to Write Mode checklist in `docs/FREEE_MCP_OPERATIONS.md`.

## Template 3: "Misclassification (Account/Tax Code Wrong)"

Goal: confirm the misclassification pattern and decide between code fix vs one-off fix.

Steps:

1. Confirm auth + company.
2. Pull examples:
   - 3 correct records
   - 3 incorrect records
3. Compare the fields that differ (account item, tax code, partner, memo).
4. If a deterministic rule exists (e.g. partner + memo pattern):
   - implement it in production (preferred)
5. Only if it is an isolated mistake:
   - use Write Mode (one-by-one) with before/after snapshots.

Tip:

- Don't jump to patching. First, extract the *smallest reproducible set* (3 correct vs 3 incorrect) and write down the rule you think is failing. This prevents "whack-a-mole" edits in freee.

Local comparison (optional, read-only):

```bash
node scripts/freee-mcp/analyze-misclassification.mjs <correct.json> <incorrect.json> --out <sessionDir>/40_changes/misclassification_report.json
```
