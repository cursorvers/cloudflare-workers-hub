-- Migration 0029: Track freee receipt↔deal link verification/backfill attempts
-- Purpose:
-- - Backfill legacy deals created without receipt evidence linked (receipt_ids missing)
-- - Avoid re-linking the same deal every cron run (rate limit protection)
-- Created: 2026-02-13

-- Note: D1 does not support IF NOT EXISTS on ALTER TABLE ADD COLUMN.
-- This migration is intended to run once.

ALTER TABLE receipt_deals ADD COLUMN link_verified_at TEXT;
ALTER TABLE receipt_deals ADD COLUMN link_retry_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE receipt_deals ADD COLUMN link_last_attempt_at TEXT;
ALTER TABLE receipt_deals ADD COLUMN link_last_error TEXT;

CREATE INDEX IF NOT EXISTS idx_receipt_deals_link_unverified
  ON receipt_deals(link_verified_at)
  WHERE link_verified_at IS NULL;

