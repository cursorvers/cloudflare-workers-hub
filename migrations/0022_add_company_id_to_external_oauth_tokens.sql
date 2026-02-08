-- Migration 0022: Add company_id to external_oauth_tokens
-- Purpose:
--   - Allow storing freee company_id in D1 alongside OAuth tokens so Workers can
--     operate without requiring FREEE_COMPANY_ID as a secret/env var.

ALTER TABLE external_oauth_tokens ADD COLUMN company_id TEXT;

