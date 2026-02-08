# KV Optimizer (Audit-First Toolkit)

This is a small, standalone toolkit to **reduce KV fragility** by:
- auditing KV `put/get/list/delete` usage in code (static analysis, no production impact)
- generating a prioritized migration checklist (KV -> D1/DO) for control-plane state
- preventing regressions by running in CI on a schedule

It does **not** try to "clean KV to increase quota" (that is usually the wrong lever).
The goal is to identify hot paths and control-plane KV dependence.

## Quick start

```bash
cd Dev/cloudflare-workers-hub
node tools/kv-optimizer/kv-optimizer.mjs scan --root .
```

## Baseline + regression check (CI-friendly)

1) Generate/update baseline JSON (commit it):

```bash
cd Dev/cloudflare-workers-hub
node tools/kv-optimizer/kv-optimizer.mjs scan --root . --json tools/kv-optimizer/baseline.json
```

2) Check current code against the baseline (fails if KV usage regresses beyond allowed thresholds):

```bash
cd Dev/cloudflare-workers-hub
node tools/kv-optimizer/kv-optimizer.mjs check --root . --baseline tools/kv-optimizer/baseline.json
```

Threshold tuning (optional):
- `--allow-total-increase N`
- `--allow-puts-increase N`
- `--allow-puts-without-ttl-increase N`
- `--allow-lists-increase N`

## Ignoring intentional fallbacks

If you intentionally keep a KV callsite as a temporary/backward-compatibility fallback, you can silence the scanner:
- `// kv-optimizer:ignore` (ignore the current line)
- `// kv-optimizer:ignore-next` (ignore the next non-empty, non-comment line)

## Output

- Console summary (bindings, call counts, TTL usage)
- Optional JSON report: `--json out.json`
