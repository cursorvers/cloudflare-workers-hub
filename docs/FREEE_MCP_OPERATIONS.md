# freee-mcp Operations (Adoption For "Our System")

This document defines how we adopt `@him0/freee-mcp` in our system *without* making production depend on it.

Positioning:

- Production automation (Workers) stays deterministic and self-contained.
- `freee-mcp` is an **operator tool** for investigation, verification, and carefully-scoped one-off fixes.

This matters because upstream explicitly states the project is still under development, and because MCP tools include generic write operations. Treat it as a sharp tool.

## Operating Modes

Default to **Read-Only Mode**. Only allow **Write Mode** as an exception with a checklist.

### Read-Only Mode (Default)

Allowed tools:

- `freee_auth_status`
- `freee_list_companies`
- `freee_get_current_company`
- `freee_api_list_paths`
- `freee_api_get`

Disallowed tools:

- `freee_api_post`
- `freee_api_put`
- `freee_api_patch`
- `freee_api_delete`

### Write Mode (Exception Only)

Write tools are allowed only after:

- A written change plan exists (what, why, scope, rollback).
- Targets are enumerated (IDs) and snapshot is captured (before state).
- Current company is confirmed.
- The operator explicitly approves the exact request payload(s).

## Security Posture

We treat the freee-mcp local config as sensitive material:

- Local files live under `~/.config/freee-mcp/` (includes tokens).
- Do not sync this directory to shared drives or cloud backup.
- Prefer a dedicated operator machine profile and a dedicated freee operator account.
- Scope the freee app permissions to the minimum needed for the job.

## Non-Negotiable Safety Checks

Run these at the start of every session:

1. `freee_auth_status` (ensure token is valid)
2. `freee_get_current_company` (ensure you are operating on the intended company)

If the company is wrong, switch it before doing anything else:

- Use `freee_list_companies` to find the target.
- Use the upstream company-switch tool (per README) and re-check current company.

## Incident Workflow (Standard)

Use this flow for investigations like "a receipt seems missing", "duplicates exist", or "automation misclassified something".

1. Open a session folder to capture evidence.
2. Confirm auth and company.
3. Identify the relevant API paths via `freee_api_list_paths` (search by keyword in the output).
4. Use `freee_api_get` to pull:
   - the candidate list (narrow by date range if the endpoint supports it)
   - the specific record (by ID)
5. Record findings, then decide:
   - No action, just document.
   - Fix in production code (preferred if it will recur).
   - One-off fix (Write Mode, below).

See templates: `docs/FREEE_MCP_INCIDENT_TEMPLATES.md`.
See endpoint selection: `docs/FREEE_MCP_PATH_DISCOVERY.md`.

## One-Off Fixes (Write Mode Checklist)

Hard requirement: fixes must be *small*, *auditable*, and *reproducible*.

Checklist:

- Define the minimal scope.
- Export a target list (IDs) into a file.
- Fetch "before" snapshots for each target with `freee_api_get`.
- Prepare the exact write payload(s) in a text file and review them.
- Execute writes one-by-one (avoid bulk operations).
- Fetch "after" snapshots for each target with `freee_api_get`.
- Record a short postmortem note with:
  - why it happened
  - whether we need a production guardrail

If you cannot identify stable record IDs, do not proceed with write operations.

## Prompt Template (Claude Desktop / Claude Code)

Use this as the first message in a freee-mcp session:

```text
You are operating freee via freee-mcp.

Rules:
- Start with freee_auth_status, then freee_get_current_company.
- Default to READ-ONLY. Do not call freee_api_post/put/patch/delete.
- If a write seems necessary, stop and ask me to confirm after you have:
  - listed the exact target IDs
  - fetched the current "before" state
  - drafted the exact request payload(s)

Goal:
<write your concrete goal here>
```

## Suggested Local Logging

We keep operator artifacts outside git (repo ignores `logs/`).

Create a session folder:

```bash
bash scripts/freee-mcp/new-session.sh "incident-short-title"
```

Or use the guided wrapper:

```bash
bash scripts/freee-mcp/start-session.sh "incident-short-title"
```

Saving evidence (recommended):

- Save raw JSON responses (lists/details) under `30_results/`.
- If you copied JSON to clipboard (macOS):

```bash
bash scripts/freee-mcp/save-json-from-clipboard.sh <sessionDir>/30_results/candidates.json
```

- Or from a file/stdin:

```bash
cat response.json | node scripts/freee-mcp/save-json.mjs <sessionDir>/30_results/candidates.json
```

In that folder, store:

- `10_plan.md` (what you are trying to confirm/change)
- `20_queries.md` (the exact MCP tool calls you executed)
- `30_results/` (JSON responses or summaries)
- `40_changes/` (payload drafts, before/after snapshots)
