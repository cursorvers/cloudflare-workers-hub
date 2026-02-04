-- Migration: Web Receipt Sources Management
-- Purpose: Track configured web scraping sources and their execution status
-- Date: 2026-02-04

-- ============================================================================
-- Web Receipt Sources Table
-- ============================================================================

CREATE TABLE IF NOT EXISTS web_receipt_sources (
  id TEXT PRIMARY KEY,              -- Source ID (e.g., "stripe", "cloudflare")
  name TEXT NOT NULL,               -- Display name
  description TEXT,                 -- Human-readable description
  enabled INTEGER NOT NULL DEFAULT 1, -- 0 = disabled, 1 = enabled
  url TEXT NOT NULL,                -- Base URL for scraping
  schedule_frequency TEXT NOT NULL, -- "daily", "weekly", "monthly"
  schedule_day_of_month INTEGER,   -- 1-31 for monthly
  schedule_hour INTEGER NOT NULL,   -- 0-23
  last_run_at TEXT,                 -- ISO 8601 timestamp of last execution
  last_run_status TEXT,             -- "success", "failed", "partial"
  last_run_receipts_count INTEGER DEFAULT 0, -- Number of receipts downloaded
  last_error TEXT,                  -- Last error message
  total_runs INTEGER DEFAULT 0,     -- Total number of executions
  total_receipts INTEGER DEFAULT 0, -- Total receipts downloaded
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_web_receipt_sources_enabled
  ON web_receipt_sources(enabled);

CREATE INDEX IF NOT EXISTS idx_web_receipt_sources_schedule
  ON web_receipt_sources(schedule_frequency, enabled);

CREATE INDEX IF NOT EXISTS idx_web_receipt_sources_last_run
  ON web_receipt_sources(last_run_at);

-- ============================================================================
-- Web Receipt Source Execution Logs
-- ============================================================================

CREATE TABLE IF NOT EXISTS web_receipt_source_logs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  source_id TEXT NOT NULL,          -- FK to web_receipt_sources
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  status TEXT NOT NULL,             -- "running", "success", "failed", "partial"
  receipts_count INTEGER DEFAULT 0, -- Number of receipts downloaded
  error_message TEXT,
  error_details TEXT,               -- JSON with error details
  metadata TEXT,                    -- JSON with execution metadata
  FOREIGN KEY (source_id) REFERENCES web_receipt_sources(id) ON DELETE CASCADE
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_web_receipt_source_logs_source
  ON web_receipt_source_logs(source_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_web_receipt_source_logs_status
  ON web_receipt_source_logs(status);

-- ============================================================================
-- Trigger: Update updated_at on web_receipt_sources
-- ============================================================================

CREATE TRIGGER IF NOT EXISTS update_web_receipt_sources_timestamp
  AFTER UPDATE ON web_receipt_sources
  FOR EACH ROW
BEGIN
  UPDATE web_receipt_sources
  SET updated_at = datetime('now')
  WHERE id = NEW.id;
END;

-- ============================================================================
-- Initial Data (Disabled by default)
-- ============================================================================

INSERT OR IGNORE INTO web_receipt_sources (
  id,
  name,
  description,
  enabled,
  url,
  schedule_frequency,
  schedule_day_of_month,
  schedule_hour
) VALUES
  ('stripe', 'Stripe', 'Stripe invoices and receipts', 0, 'https://dashboard.stripe.com/invoices', 'monthly', 1, 2),
  ('cloudflare', 'Cloudflare', 'Cloudflare billing invoices', 0, 'https://dash.cloudflare.com/billing', 'monthly', 5, 3),
  ('aws', 'AWS', 'AWS billing invoices', 0, 'https://console.aws.amazon.com/billing/home#/bills', 'monthly', 3, 4);
