-- Migration 0016: Add columns for freee deal automation
-- Purpose: Support automatic deal creation and receipt-deal linking
-- Created: 2026-02-06
-- Context: Both Gmail poller and Chrome extension converge at handleReceiptUpload()

-- Add freee deal ID for linking receipts to deals
ALTER TABLE receipts ADD COLUMN freee_deal_id INTEGER;

-- Add freee partner ID for vendor tracking
ALTER TABLE receipts ADD COLUMN freee_partner_id INTEGER;

-- Add mapped account item ID from freee master data
ALTER TABLE receipts ADD COLUMN account_item_id INTEGER;

-- Add tax code from freee master data
ALTER TABLE receipts ADD COLUMN tax_code INTEGER;

-- Add confidence score for account mapping (0.0-1.0)
ALTER TABLE receipts ADD COLUMN account_mapping_confidence REAL;

-- Add method used for account mapping
ALTER TABLE receipts ADD COLUMN account_mapping_method TEXT CHECK(
  account_mapping_method IN ('exact', 'substring', 'levenshtein', 'fallback', 'manual')
);

-- Index for deal lookup and orphan detection
CREATE INDEX IF NOT EXISTS idx_receipts_freee_deal_id
  ON receipts(freee_deal_id);

-- Index for partner-based queries
CREATE INDEX IF NOT EXISTS idx_receipts_freee_partner_id
  ON receipts(freee_partner_id);

-- Index for finding receipts that need deal creation (status-based)
CREATE INDEX IF NOT EXISTS idx_receipts_deal_pending
  ON receipts(status) WHERE freee_deal_id IS NULL AND status = 'freee_uploaded';

-- Idempotency table for deal creation (prevents duplicate deals)
CREATE TABLE IF NOT EXISTS receipt_deals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_id TEXT NOT NULL,
  deal_id INTEGER NOT NULL,
  partner_id INTEGER,
  mapping_confidence REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK(status IN ('created', 'needs_review')) DEFAULT 'created',
  idempotency_key TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(receipt_id),
  UNIQUE(idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_receipt_deals_status
  ON receipt_deals(status);

CREATE INDEX IF NOT EXISTS idx_receipt_deals_idempotency
  ON receipt_deals(idempotency_key);
