# freee-mcp Usage (Local Debugging / Ops)

This repo runs freee ingestion in a Cloudflare Worker. Separately, you can use `@him0/freee-mcp` locally to inspect or operate freee via Claude Desktop / Claude Code.

Use-cases:

- Confirm a receipt/deal exists in freee without writing custom scripts.
- Explore freee API paths + required fields quickly (with OpenAPI validation).
- Build correct request payloads for one-off fixes, then port the minimal subset into this Worker if needed.

See also: `docs/FREEE_MCP_OPERATIONS.md` (guardrails, read-only policy, incident workflow).
See also: `docs/FREEE_MCP_INCIDENT_TEMPLATES.md` (copy/paste investigation flows).
See also: `docs/FREEE_MCP_PATH_DISCOVERY.md` (how to choose endpoints from list_paths).
Default playbook: `docs/FREEE_MCP_EXPENSE_PLAYBOOK.md` (expense-first, evidence-first).

## Install / Configure

Follow the upstream project:

- Repo: https://github.com/him0/freee-mcp

We pin a known-good version for repeatability (update intentionally):

```bash
npx @him0/freee-mcp@0.6.4 configure
```

Typical flow:

```bash
npx @him0/freee-mcp@0.6.4 configure
```

This runs an interactive wizard to do OAuth and store credentials in a local config file.

Notes:

- freee callback URL is `http://localhost:54321/callback` (configure step will guide you).
- Tokens/config are stored locally under `~/.config/freee-mcp/` (treat this as sensitive).
- Config via environment variables is deprecated upstream; use `configure`.

## Add To Claude Desktop

Add the MCP server as instructed by `configure`, typically:

```json
{
  "mcpServers": {
    "freee": {
      "command": "npx",
      "args": ["@him0/freee-mcp"]
    }
  }
}
```

If you prefer a pinned version in Claude Desktop config, set:

```json
{
  "mcpServers": {
    "freee": {
      "command": "npx",
      "args": ["@him0/freee-mcp@0.6.4"]
    }
  }
}
```

## Notes For This Project

- `freee-mcp` is a local MCP server; it is not intended to run inside Cloudflare Workers.
- Cloudflare Workers secrets are per-script (e.g. `orchestrator-hub` vs `orchestrator-hub-canary`). This is independent of `freee-mcp`'s local config.
- If you need a one-off fix in production: prefer using `freee-mcp` locally to validate the API call, then implement the minimal safe endpoint in this Worker with admin auth (`ADMIN_API_KEY`) and strict input validation.

## Quickstart (Ops)

Start an evidence-first session (recommended):

```bash
bash scripts/freee-mcp/start-session.sh "incident-title"
```

Then follow:

- `docs/FREEE_MCP_PATH_DISCOVERY.md` to choose endpoints from `freee_api_list_paths`
- `docs/FREEE_MCP_INCIDENT_TEMPLATES.md` for 1/2/3 incident flows
- `docs/FREEE_MCP_OPERATIONS.md` for the write-mode checklist (exception only)

Upstream tool surface (MCP tools):

- Safe-ish (read): `freee_auth_status`, `freee_list_companies`, `freee_get_current_company`, `freee_api_list_paths`, `freee_api_get`
- Dangerous (write): `freee_api_post`, `freee_api_put`, `freee_api_patch`, `freee_api_delete`
