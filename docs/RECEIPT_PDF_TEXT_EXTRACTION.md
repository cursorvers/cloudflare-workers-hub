# Receipt PDF Text Extraction (unpdf)

This project can optionally extract text from receipt PDFs and feed it into the receipt classifier.
It is designed for **safe, staged rollout**: disabled by default, sampled, size-capped, and failure-tolerant.

For a production rollout checklist, see `docs/RECEIPT_PDF_TEXT_EXTRACTION_RUNBOOK.md`.

## What It Does

- Extracts text from PDF attachments using `unpdf` (pdf.js).
- Appends extracted text to the classification prompt only when explicitly enabled.
- Logs extraction metrics for validation (without logging the extracted text itself).

## Safety Properties

- Default OFF via `wrangler.toml` (`PDF_TEXT_EXTRACTION_ENABLED = "false"`).
- Sampling gate via `PDF_TEXT_EXTRACTION_SAMPLE_RATE` (default `0`).
- Input guards before parsing:
  - Empty input
  - Size limit (`PDF_TEXT_EXTRACTION_MAX_BYTES`, default 10MB)
  - Magic header check (`%PDF-`)
- Hard caps after parsing:
  - Page limit (`PDF_TEXT_EXTRACTION_MAX_PAGES`, default 50)
  - Prompt truncation (`PDF_TEXT_EXTRACTION_MAX_CHARS`, default 8000)
- Fail-soft: extraction errors never block receipt processing.
- Dynamic import keeps the hot path clean when disabled: `src/services/pdf-text-extraction.ts`.

## Configuration (Env Vars)

All values are strings (Workers vars).

- `PDF_TEXT_EXTRACTION_ENABLED`
  - `"true"` enables extraction; anything else disables.
- `PDF_TEXT_EXTRACTION_SAMPLE_RATE`
  - `0.0` to `1.0` (default `0`).
- `PDF_TEXT_EXTRACTION_MAX_BYTES`
  - default `10485760` (10MB).
- `PDF_TEXT_EXTRACTION_MAX_PAGES`
  - default `50`.
- `PDF_TEXT_EXTRACTION_MAX_CHARS`
  - default `8000` (how much extracted text is appended to the prompt).
- `PDF_TEXT_EXTRACTION_USE_FOR_CLASSIFICATION`
  - `"true"` appends extracted text into the classifier prompt (default `"false"`).

## Rollout Recommendation

1. Enable extraction in log-only mode:
   - `PDF_TEXT_EXTRACTION_ENABLED="true"`
   - `PDF_TEXT_EXTRACTION_SAMPLE_RATE="0.01"` (start small)
   - `PDF_TEXT_EXTRACTION_USE_FOR_CLASSIFICATION="false"`
2. Confirm logs and latency:
   - Look for `[PDF Text Extraction] ...` logs and the poll summary fields from the Gmail poller.
3. Increase sample rate gradually.
4. Only then enable prompt injection:
   - `PDF_TEXT_EXTRACTION_USE_FOR_CLASSIFICATION="true"`

Tip: if you want a "master switch" that effectively disables extraction while keeping the feature enabled,
set `PDF_TEXT_EXTRACTION_SAMPLE_RATE="0"`. The system will report `sampled_out` (no parse attempted).

## Where It Runs

- Gmail attachment pipeline:
  - `src/handlers/receipt-gmail-poller.ts`
  - `src/services/pdf-text-extraction.ts`
  - `src/services/pdf-text-extractor.ts`

## Local Verification

- Bundle size of `unpdf` alone:
  - `npm run measure:unpdf`
- Worker upload size (local build only):
  - `npm run measure:worker`
- Generate an inspectable bundle and metafile (no deploy):
  - `npx wrangler deploy --dry-run --outdir /tmp/wrangler-bundle --metafile /tmp/wrangler-meta.json`
  - `rg -n \"unpdf|pdfjs\" /tmp/wrangler-bundle/index.js`

## PoC Endpoints (Dev Only)

These are explicitly blocked unless `env.ENVIRONMENT === "development"`.

- Smoke:
  - `npm run poc:unpdf`
  - `GET http://127.0.0.1:8791/__poc/unpdf`
- Upload a PDF and extract:
  - `npm run poc:extract-pdf`
  - `node scripts/poc-extract-pdf-file.mjs /path/to/file.pdf`

## Operational Notes

- Default values live in `wrangler.toml` under `[vars]` and `[env.canary].vars`.
- If you override vars in the Cloudflare dashboard, a future `wrangler deploy` may overwrite them unless you deploy with `--keep-vars=true`.
- `PDF_TEXT_EXTRACTION_USE_FOR_CLASSIFICATION` should remain `"false"` until you've validated:
  - extraction success rate
  - CPU/latency impact
  - whether the classifier quality actually improves for your receipts

## Production Toggle (Recommended)

Use the Cloudflare dashboard to override Worker variables for production. This avoids a code deploy.

Suggested initial values:

- `PDF_TEXT_EXTRACTION_ENABLED="true"`
- `PDF_TEXT_EXTRACTION_SAMPLE_RATE="0.01"`
- `PDF_TEXT_EXTRACTION_USE_FOR_CLASSIFICATION="false"`
- Keep defaults for `MAX_BYTES/MAX_PAGES/MAX_CHARS` initially.

Rollback:

- Set `PDF_TEXT_EXTRACTION_SAMPLE_RATE="0"` (immediate effect, no parsing attempted), or
- Set `PDF_TEXT_EXTRACTION_ENABLED="false"`

## What To Watch In Logs

- Per-attachment:
  - `[PDF Text Extraction] Extracted PDF text`
  - `[PDF Text Extraction] Skipped (...)`
  - `[PDF Text Extraction] Failed to extract PDF text (continuing without it)`
- Per poll run summary (only included when `PDF_TEXT_EXTRACTION_ENABLED="true"`):
  - `pdfTextAttempted`, `pdfTextExtracted`, `pdfTextFailed`, `pdfTextSkipped`, `pdfTextNotAttempted`
  - `pdfTextTotalElapsedMs`, `pdfTextReasons`
