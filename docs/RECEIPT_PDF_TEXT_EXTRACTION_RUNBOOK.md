# Runbook: Receipt PDF Text Extraction (Production Rollout)

Date: 2026-02-07

Goal: enable PDF text extraction safely (sampled, log-only first) without breaking receipt ingestion.

## Preconditions

- You can access the Cloudflare dashboard for the Worker `orchestrator-hub` (production env).
- You can tail logs (`wrangler tail`) for the production deployment.
- Note: in this repo, `wrangler.toml` sets `[triggers].crons = ["*/15 * * * *"]` and `SCHEDULED_GMAIL_ONLY="true"`, so Gmail polling will run automatically every 15 minutes on `orchestrator-hub`.

## Phase 1 (Log-Only, Sampled)

Set these production vars (Cloudflare dashboard):

- `PDF_TEXT_EXTRACTION_ENABLED` = `"true"`
- `PDF_TEXT_EXTRACTION_SAMPLE_RATE` = `"0.01"`
- `PDF_TEXT_EXTRACTION_USE_FOR_CLASSIFICATION` = `"false"`

Keep defaults initially:

- `PDF_TEXT_EXTRACTION_MAX_BYTES` = `"10485760"`
- `PDF_TEXT_EXTRACTION_MAX_PAGES` = `"50"`
- `PDF_TEXT_EXTRACTION_MAX_CHARS` = `"8000"`

### Verify

1. Tail logs in another terminal:

```bash
# Canonical production (orchestrator-hub)
npx wrangler tail --format pretty
```

Optional: filter only PDF extraction logs:

```bash
npx wrangler tail --format pretty --search "[PDF Text Extraction]"
```

Canary（orchestrator-hub-canary）も見たい場合:

```bash
npx wrangler tail --env canary --format pretty
```

2. Trigger Gmail polling once:

```bash
export ADMIN_API_KEY=<your_admin_key>
bash scripts/trigger-receipts-poll.sh
```

3. Confirm you see poller logs and (sampled) extraction logs.
3. Confirm you see **some** of the following, at low volume:

- `[PDF Text Extraction] Skipped (...)`
- `[PDF Text Extraction] Extracted PDF text`
- `[PDF Text Extraction] Failed to extract PDF text (continuing without it)`

4. Confirm the poll summary log includes PDF extraction aggregates when enabled:

- `pdfTextAttempted`, `pdfTextExtracted`, `pdfTextFailed`, `pdfTextSkipped`, `pdfTextNotAttempted`
- `pdfTextTotalElapsedMs`, `pdfTextReasons`

### Acceptance Criteria (Phase 1)

- No increase in receipt pipeline failures (compare `[Gmail Poller] Polling completed` `failed` counts).
- `pdfTextFailed` is low and dominated by `not_pdf/too_large/empty/sampled_out` rather than `error`.
- Latency impact is acceptable at 1% sample.

## Phase 2 (Increase Sample Rate)

Gradually increase `PDF_TEXT_EXTRACTION_SAMPLE_RATE` (examples):

- `"0.02"` then `"0.05"` then `"0.10"`

Hold for at least one business day between increases, unless you are actively watching tails.

## Phase 3 (Use Extracted Text For Classification)

Only after Phase 1/2 are stable:

- Set `PDF_TEXT_EXTRACTION_USE_FOR_CLASSIFICATION` = `"true"`

Keep sample rate modest at first (e.g. `"0.02"` to `"0.05"`), and watch classification quality + AI usage.

## Rollback (Immediate)

Fastest rollback (keeps feature “enabled” but does zero parsing):

- Set `PDF_TEXT_EXTRACTION_SAMPLE_RATE` = `"0"`

Hard off:

- Set `PDF_TEXT_EXTRACTION_ENABLED` = `"false"`

## Notes About Deployments

- Defaults in `wrangler.toml` are OFF for safety.
- If you override vars in the Cloudflare dashboard, a future `wrangler deploy` can overwrite them unless you deploy with `--keep-vars=true`.
