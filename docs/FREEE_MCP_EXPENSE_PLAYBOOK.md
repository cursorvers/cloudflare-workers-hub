# freee-mcp Expense Playbook (No Questions, Evidence-First)

This is the default playbook for our system: treat **expenses (経費)** as the first-class entity.

## Start

```bash
cd Dev/cloudflare-workers-hub
bash scripts/freee-mcp/start-session.sh "expense-incident"
```

In Claude (freee-mcp session), follow the prompt in `00_prompt_readonly.txt`.

Tip: to refer to the latest session without copy-pasting paths:

```bash
SESSION="$(bash scripts/freee-mcp/latest-session.sh)"
echo "$SESSION"
```

## Step 1: Endpoint Selection (Read-Only)

1. Run `freee_api_list_paths`.
2. Save output:
   - If you copied JSON: save as `30_results/paths.json`
     - `bash scripts/freee-mcp/save-json-from-clipboard.sh <sessionDir>/30_results/paths.json`
   - If you copied plain text: save as `30_results/paths.txt`
     - `bash scripts/freee-mcp/save-text-from-clipboard.sh <sessionDir>/30_results/paths.txt`
3. Filter locally (start with expense keywords):

```bash
node scripts/freee-mcp/filter-paths.mjs <sessionDir>/30_results/paths.txt --query expense
node scripts/freee-mcp/filter-paths.mjs <sessionDir>/30_results/paths.txt --query expense_application
```

Pick the best **GET list** endpoint.

## Step 2: Pull Candidate List (Tight Window)

In freee-mcp, run a list `freee_api_get` for the smallest possible time window (start with 1 day).

Save raw response as:

- `<sessionDir>/30_results/candidates.json`
  - `bash scripts/freee-mcp/save-json-from-clipboard.sh <sessionDir>/30_results/candidates.json`

## Step 3: Triage By Incident Type (Local, Read-Only)

Or run all triage steps that are possible (based on evidence files present):

```bash
node scripts/freee-mcp/triage.mjs <sessionDir>
```

### A) Not Found

```bash
node scripts/freee-mcp/triage-not-found.mjs <sessionDir>
```

### B) Duplicates

```bash
node scripts/freee-mcp/triage-duplicates.mjs <sessionDir>
```

Then fetch detail GETs for each ID (and save as `details_<id>.json`) before considering any write.

### C) Misclassification

1. Save 3-10 correct examples to `<sessionDir>/40_changes/correct.json`
2. Save 3-10 incorrect examples to `<sessionDir>/40_changes/incorrect.json`
3. Compare (one command):

```bash
node scripts/freee-mcp/triage-misclassification.mjs <sessionDir>
```

## Step 4: Fix Decision

Preferred: fix production code for systematic issues.

Exception: one-off fix in freee requires `40_changes/WRITE_APPROVAL.md` per `docs/FREEE_MCP_OPERATIONS.md`.
