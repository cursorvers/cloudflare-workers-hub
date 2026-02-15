-- Migration 0029: FX Rate Service
-- Purpose: Append-only FX rate audit trail + receipt FX metadata columns
-- Design: Tutti 6-agent consensus (2026-02-15)
-- Created: 2026-02-16

-- =============================================================================
-- FX Rate Table (Append-Only / Immutable)
-- =============================================================================
-- Stores USD→JPY rates with full provenance for tax compliance.
-- WORM guarantee via triggers (no UPDATE/DELETE).
CREATE TABLE IF NOT EXISTS fx_rates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pair TEXT NOT NULL DEFAULT 'USDJPY',       -- Currency pair (e.g. USDJPY)
  requested_date TEXT NOT NULL,               -- Transaction date originally requested (YYYY-MM-DD)
  used_date TEXT NOT NULL,                    -- Actual date the rate was sourced from
  rate REAL NOT NULL,                         -- Exchange rate (e.g. 149.50)
  source TEXT NOT NULL,                       -- Rate provider (e.g. open.er-api.com)
  rate_type TEXT NOT NULL DEFAULT 'TTM',      -- TTM | TTS | TTB
  fetched_at TEXT NOT NULL,                   -- ISO 8601 timestamp of fetch
  sanity_ok INTEGER NOT NULL DEFAULT 1,       -- 1=passed range check, 0=failed
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- =============================================================================
-- WORM Guarantee: Prevent UPDATE/DELETE on fx_rates
-- =============================================================================
CREATE TRIGGER IF NOT EXISTS prevent_fx_rates_update
BEFORE UPDATE ON fx_rates
BEGIN
  SELECT RAISE(ABORT, 'FX rate record is immutable (WORM guarantee)');
END;

CREATE TRIGGER IF NOT EXISTS prevent_fx_rates_delete
BEFORE DELETE ON fx_rates
BEGIN
  SELECT RAISE(ABORT, 'FX rate record is immutable (WORM guarantee)');
END;

-- =============================================================================
-- Indexes for FX Rate Lookup
-- =============================================================================
-- Primary lookup: pair + requested_date (ordered by fetched_at DESC)
CREATE INDEX IF NOT EXISTS idx_fx_rates_lookup
  ON fx_rates(pair, requested_date, fetched_at DESC);

-- Audit query: by source
CREATE INDEX IF NOT EXISTS idx_fx_rates_source
  ON fx_rates(source, fetched_at);

-- =============================================================================
-- Receipt FX Metadata Columns
-- =============================================================================
-- Add FX conversion metadata to receipts for audit trail.
-- These columns record what rate was used when converting foreign currency receipts.
ALTER TABLE receipts ADD COLUMN original_amount REAL;
ALTER TABLE receipts ADD COLUMN original_currency TEXT;
ALTER TABLE receipts ADD COLUMN fx_rate REAL;
ALTER TABLE receipts ADD COLUMN fx_rate_date TEXT;
ALTER TABLE receipts ADD COLUMN fx_rate_source TEXT;
ALTER TABLE receipts ADD COLUMN fx_rate_type TEXT;
ALTER TABLE receipts ADD COLUMN fx_sanity_ok INTEGER;
