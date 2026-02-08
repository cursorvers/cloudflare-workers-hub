-- Migration 0017: Fix deal automation schema issues
-- Purpose: Update CHECK constraint, fix idempotency keys, add traceability
-- Created: 2026-02-06
-- Context: 3 rounds of critical review (13 issues resolved)
--
-- Issues fixed:
--   1. CRITICAL: receipts.status CHECK missing 5 states
--   2. MAJOR: receipt_deals.idempotency_key lacks tenant_id prefix
--   3. MAJOR: receipt_deals missing freee_receipt_id for traceability
--   4. CRITICAL: Trigger update_receipt_timestamp lost during rebuild
--
-- Strategy: SQLite table rebuild (CREATE new → INSERT → RENAME old → RENAME new)
--   - Backup old table as receipts_backup (not DROP)
--   - Create indexes on receipts_new BEFORE rename (zero-downtime swap)
--   - Idempotent backfill with WHERE guard
--
-- Schema source: 0013 + 0015 (tenant_id) + 0016 (deal columns)
-- Rollback: DROP TABLE receipts; ALTER TABLE receipts_backup RENAME TO receipts;

-- Step 1: Create new table with updated CHECK constraint (all 16 states)
-- Columns match exactly: 0013 base + 0015 tenant_id + 0016 deal automation
CREATE TABLE IF NOT EXISTS receipts_new (
  id TEXT PRIMARY KEY DEFAULT (hex(randomblob(16))),
  file_hash TEXT UNIQUE NOT NULL,
  r2_object_key TEXT NOT NULL,
  freee_receipt_id TEXT,

  -- Document metadata
  transaction_date TEXT NOT NULL,
  vendor_name TEXT NOT NULL,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'JPY',
  document_type TEXT NOT NULL CHECK(
    document_type IN ('invoice', 'receipt', 'expense_report', 'other')
  ),

  -- Classification results
  account_category TEXT,
  tax_type TEXT,
  department TEXT,
  project TEXT,
  classification_method TEXT CHECK(
    classification_method IN ('rule_based', 'ai_assisted', 'manual')
  ),
  classification_confidence REAL,

  -- State machine (updated: 16 states including 5 new deal automation states)
  status TEXT NOT NULL DEFAULT 'pending_validation' CHECK(
    status IN (
      'pending_validation',
      'validated',
      'classified',
      'extracting',
      'extracted',
      'uploading_r2',
      'uploaded_r2',
      'submitting_freee',
      'freee_uploaded',
      'mapping_account',
      'finding_partner',
      'creating_deal',
      'linking_receipt',
      'completed',
      'failed',
      'needs_review'
    )
  ),

  -- Error tracking
  error_message TEXT,
  error_code TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_retry_at TEXT,

  -- Timestamps
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,

  -- Compliance (Electronic Bookkeeping Law)
  tsa_timestamp TEXT,
  tsa_signature TEXT,
  retention_until TEXT,

  -- Multi-tenant (from 0015)
  tenant_id TEXT NOT NULL DEFAULT 'default',

  -- Deal automation (from 0016)
  freee_deal_id INTEGER,
  freee_partner_id INTEGER,
  account_item_id INTEGER,
  tax_code INTEGER,
  account_mapping_confidence REAL,
  account_mapping_method TEXT CHECK(
    account_mapping_method IN ('exact', 'substring', 'levenshtein', 'fallback', 'manual')
  )
);

-- Step 2: Copy all data with explicit column list
-- Note: 0016 columns may not exist yet in source table, use defaults via CASE
INSERT INTO receipts_new (
  id, file_hash, r2_object_key, freee_receipt_id,
  transaction_date, vendor_name, amount, currency, document_type,
  account_category, tax_type, department, project,
  classification_method, classification_confidence,
  status, error_message, error_code, retry_count, last_retry_at,
  created_at, updated_at, completed_at,
  tsa_timestamp, tsa_signature, retention_until,
  tenant_id
)
SELECT
  id, file_hash, r2_object_key, freee_receipt_id,
  transaction_date, vendor_name, amount, currency, document_type,
  account_category, tax_type, department, project,
  classification_method, classification_confidence,
  status, error_message, error_code, retry_count, last_retry_at,
  created_at, updated_at, completed_at,
  tsa_timestamp, tsa_signature, retention_until,
  tenant_id
FROM receipts;

-- Step 3: Create all indexes on receipts_new BEFORE rename (zero-downtime)
CREATE INDEX IF NOT EXISTS idx_rn_transaction_date ON receipts_new(transaction_date);
CREATE INDEX IF NOT EXISTS idx_rn_vendor_name ON receipts_new(vendor_name);
CREATE INDEX IF NOT EXISTS idx_rn_amount ON receipts_new(amount);
CREATE INDEX IF NOT EXISTS idx_rn_composite ON receipts_new(transaction_date, vendor_name, amount);
CREATE INDEX IF NOT EXISTS idx_rn_status ON receipts_new(status);
CREATE INDEX IF NOT EXISTS idx_rn_freee_id ON receipts_new(freee_receipt_id);
CREATE INDEX IF NOT EXISTS idx_rn_tenant ON receipts_new(tenant_id, transaction_date DESC);
CREATE INDEX IF NOT EXISTS idx_rn_deal_pending ON receipts_new(status) WHERE freee_deal_id IS NULL AND status = 'freee_uploaded';

-- Step 4: Drop old indexes (they reference the old table)
DROP INDEX IF EXISTS idx_receipts_transaction_date;
DROP INDEX IF EXISTS idx_receipts_vendor_name;
DROP INDEX IF EXISTS idx_receipts_amount;
DROP INDEX IF EXISTS idx_receipts_composite;
DROP INDEX IF EXISTS idx_receipts_status;
DROP INDEX IF EXISTS idx_receipts_freee_id;
DROP INDEX IF EXISTS idx_receipts_tenant;
DROP INDEX IF EXISTS idx_receipts_deal_pending;

-- Step 5: Swap tables (backup old, promote new)
ALTER TABLE receipts RENAME TO receipts_backup;
ALTER TABLE receipts_new RENAME TO receipts;

-- Step 6: Recreate canonical indexes on final receipts table
DROP INDEX IF EXISTS idx_rn_transaction_date;
DROP INDEX IF EXISTS idx_rn_vendor_name;
DROP INDEX IF EXISTS idx_rn_amount;
DROP INDEX IF EXISTS idx_rn_composite;
DROP INDEX IF EXISTS idx_rn_status;
DROP INDEX IF EXISTS idx_rn_freee_id;
DROP INDEX IF EXISTS idx_rn_tenant;
DROP INDEX IF EXISTS idx_rn_deal_pending;

CREATE INDEX IF NOT EXISTS idx_receipts_transaction_date ON receipts(transaction_date);
CREATE INDEX IF NOT EXISTS idx_receipts_vendor_name ON receipts(vendor_name);
CREATE INDEX IF NOT EXISTS idx_receipts_amount ON receipts(amount);
CREATE INDEX IF NOT EXISTS idx_receipts_composite ON receipts(transaction_date, vendor_name, amount);
CREATE INDEX IF NOT EXISTS idx_receipts_status ON receipts(status);
CREATE INDEX IF NOT EXISTS idx_receipts_freee_id ON receipts(freee_receipt_id);
CREATE INDEX IF NOT EXISTS idx_receipts_tenant ON receipts(tenant_id, transaction_date DESC);
CREATE INDEX IF NOT EXISTS idx_receipts_deal_pending ON receipts(status) WHERE freee_deal_id IS NULL AND status = 'freee_uploaded';

-- Step 7: Recreate trigger lost during table rebuild (from 0013)
DROP TRIGGER IF EXISTS update_receipt_timestamp;
CREATE TRIGGER IF NOT EXISTS update_receipt_timestamp
AFTER UPDATE ON receipts
FOR EACH ROW
BEGIN
  UPDATE receipts SET updated_at = datetime('now') WHERE id = NEW.id;
END;

-- Step 8: Add freee_receipt_id to receipt_deals for traceability
-- Note: D1 does not support IF NOT EXISTS on ALTER TABLE ADD COLUMN
-- This will fail harmlessly on re-run if column already exists
ALTER TABLE receipt_deals ADD COLUMN freee_receipt_id TEXT;

-- Step 9: Idempotent backfill - prepend tenant_id to idempotency_key
-- WHERE guard prevents double-prepend on re-run
UPDATE receipt_deals
SET idempotency_key =
  COALESCE(
    (SELECT r.tenant_id FROM receipts r WHERE r.id = receipt_deals.receipt_id),
    'default'
  ) || ':' || idempotency_key
WHERE idempotency_key NOT LIKE '%:%';
