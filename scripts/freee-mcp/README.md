# freee-mcp Helper Scripts

This folder contains helper scripts for running `@him0/freee-mcp` as an operator tool.

## New Session Folder

```bash
bash scripts/freee-mcp/start-session.sh "incident-short-title"
```

This creates a timestamped folder under `logs/freee-mcp/` (ignored by git) with templates for plan/queries/evidence.

## Group Possible Duplicates (Read-Only)

After you save a list response as JSON (e.g. `30_results/candidates.json`), group by a deterministic key to produce a stable ID list:

```bash
node scripts/freee-mcp/group-duplicates.mjs <jsonFile> --out duplicate_groups.json
```

If the response array is not top-level, specify the array field:

```bash
node scripts/freee-mcp/group-duplicates.mjs <jsonFile> --array deals --key "issue_date|total_amount|partner_id"
```

## Find Likely Matches (Read-Only)

For "Not Found" investigations, filter the candidate list locally:

```bash
node scripts/freee-mcp/find-candidates.mjs <jsonFile> --date 2026-02-01 --amount 980 --contains "Amazon"
```

If needed, force the array field:

```bash
node scripts/freee-mcp/find-candidates.mjs <jsonFile> --array deals --partner 12345
```

## Save JSON Evidence (Clipboard -> File)

When freee-mcp returns JSON, save the raw response into your session folder.

macOS (clipboard):

```bash
bash scripts/freee-mcp/save-json-from-clipboard.sh <sessionDir>/30_results/candidates.json
```

Any OS (stdin):

```bash
cat response.json | node scripts/freee-mcp/save-json.mjs <sessionDir>/30_results/candidates.json
```

## Save Text Evidence (Clipboard -> File)

For `freee_api_list_paths` when you copied plain text:

```bash
bash scripts/freee-mcp/save-text-from-clipboard.sh <sessionDir>/30_results/paths.txt
```

## Filter list_paths Output (Optional)

If you saved `freee_api_list_paths` output (JSON array or plain text), filter locally:

```bash
node scripts/freee-mcp/filter-paths.mjs <pathsFile> --query deals
```

Recommended file names inside a session:

- `30_results/paths.txt`
- `30_results/paths.json`

## Extract IDs (Read-Only)

When you have `duplicate_groups.json` (or any candidates list), extract IDs to drive detail GETs:

```bash
node scripts/freee-mcp/extract-ids.mjs <jsonFile> --unique
```

## Triage Duplicates (One Command)

If you already saved `30_results/candidates.json` in a session:

```bash
node scripts/freee-mcp/triage-duplicates.mjs <sessionDir>
```

If you omit `<sessionDir>`, it uses the latest session under `logs/freee-mcp/`.

## Triage Not Found (One Command)

1. Save `30_results/candidates.json`
2. Edit `<sessionDir>/40_changes/not_found_query.json` (set date/amount/contains/partner)
3. Run:

```bash
node scripts/freee-mcp/triage-not-found.mjs <sessionDir>
```

## Triage Misclassification (One Command)

1. Save examples:
   - `<sessionDir>/40_changes/correct.json`
   - `<sessionDir>/40_changes/incorrect.json`
2. Run:

```bash
node scripts/freee-mcp/triage-misclassification.mjs <sessionDir>
```

## Triage (Run What You Can)

Runs duplicates / not-found / misclassification if prerequisites are present:

```bash
node scripts/freee-mcp/triage.mjs <sessionDir>
```

## Analyze Misclassification (Read-Only)

Save two small sets as JSON arrays:

- correct examples (3-10 rows)
- incorrect examples (3-10 rows)

Then compare them:

```bash
node scripts/freee-mcp/analyze-misclassification.mjs correct.json incorrect.json
```
