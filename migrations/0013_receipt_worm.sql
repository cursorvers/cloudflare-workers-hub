-- Migration 0013: Receipt Management with WORM Guarantee
-- Purpose: Electronic bookkeeping law compliant receipt storage
-- Created: 2026-02-04

-- =============================================================================
-- Receipt Master Table
-- =============================================================================
-- Stores receipt metadata with state machine transitions
-- WORM guarantee: Cannot update/delete after creation
CREATE TABLE IF NOT EXISTS receipts (
  id TEXT PRIMARY KEY DEFAULT (hex(randomblob(16))),
  file_hash TEXT UNIQUE NOT NULL,           -- SHA-256 hash of original file
  r2_object_key TEXT NOT NULL,              -- R2 bucket key (WORM storage)
  freee_receipt_id TEXT,                    -- freee File Box receipt ID

  -- Document metadata
  transaction_date TEXT NOT NULL,           -- YYYY-MM-DD format
  vendor_name TEXT NOT NULL,                -- Vendor/supplier name
  amount INTEGER NOT NULL,                  -- Amount in cents (JPY)
  currency TEXT NOT NULL DEFAULT 'JPY',
  document_type TEXT NOT NULL CHECK(document_type IN ('invoice', 'receipt', 'expense_report', 'other')),

  -- Classification results
  account_category TEXT,                    -- 勘定科目
  tax_type TEXT,                            -- 税区分
  department TEXT,                          -- 部門
  project TEXT,                             -- プロジェクト
  classification_method TEXT CHECK(classification_method IN ('rule_based', 'ai_assisted', 'manual')),
  classification_confidence REAL,           -- 0.0-1.0

  -- State machine
  status TEXT NOT NULL DEFAULT 'pending_validation' CHECK(
    status IN (
      'pending_validation',   -- Initial state
      'validated',            -- File validated (hash, format, size)
      'classified',           -- AI classification complete
      'extracting',           -- OCR/data extraction in progress
      'extracted',            -- Data extracted successfully
      'uploading_r2',         -- Uploading to R2 WORM
      'uploaded_r2',          -- R2 upload complete
      'submitting_freee',     -- Submitting to freee
      'completed',            -- Successfully registered in freee
      'failed',               -- Terminal failure state
      'needs_review'          -- Manual review required
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

  -- Compliance
  tsa_timestamp TEXT,                       -- RFC 3161 timestamp
  tsa_signature TEXT,                       -- Timestamp signature
  retention_until TEXT                      -- YYYY-MM-DD (created_at + 7 years)
);

-- =============================================================================
-- Audit Log Table (Immutable)
-- =============================================================================
-- Records all state transitions and events
-- WORM guarantee via triggers
CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK(
    event_type IN (
      'state_transition',
      'classification_result',
      'freee_submission',
      'freee_response',
      'error_occurred',
      'manual_intervention',
      'retry_attempt'
    )
  ),
  previous_status TEXT,
  new_status TEXT,

  -- Event metadata
  metadata TEXT,                            -- JSON-encoded event details
  user_id TEXT,                             -- User who triggered (if manual)
  ip_address TEXT,                          -- Request IP (if applicable)

  -- Timestamps
  created_at TEXT NOT NULL DEFAULT (datetime('now')),

  FOREIGN KEY (receipt_id) REFERENCES receipts(id) ON DELETE CASCADE
);

-- =============================================================================
-- WORM Guarantee: Prevent UPDATE/DELETE on audit_logs
-- =============================================================================
CREATE TRIGGER IF NOT EXISTS prevent_audit_update
BEFORE UPDATE ON audit_logs
BEGIN
  SELECT RAISE(ABORT, 'Audit log is immutable (WORM guarantee)');
END;

CREATE TRIGGER IF NOT EXISTS prevent_audit_delete
BEFORE DELETE ON audit_logs
BEGIN
  SELECT RAISE(ABORT, 'Audit log is immutable (WORM guarantee)');
END;

-- =============================================================================
-- Auto-update updated_at on receipts
-- =============================================================================
CREATE TRIGGER IF NOT EXISTS update_receipt_timestamp
AFTER UPDATE ON receipts
FOR EACH ROW
BEGIN
  UPDATE receipts SET updated_at = datetime('now') WHERE id = NEW.id;
END;

-- =============================================================================
-- Indexes for Electronic Bookkeeping Law Compliance
-- =============================================================================
-- Fast search by transaction date
CREATE INDEX IF NOT EXISTS idx_receipts_transaction_date
  ON receipts(transaction_date);

-- Fast search by vendor name
CREATE INDEX IF NOT EXISTS idx_receipts_vendor_name
  ON receipts(vendor_name);

-- Fast search by amount range
CREATE INDEX IF NOT EXISTS idx_receipts_amount
  ON receipts(amount);

-- Composite index for complex queries
CREATE INDEX IF NOT EXISTS idx_receipts_composite
  ON receipts(transaction_date, vendor_name, amount);

-- Fast search by status
CREATE INDEX IF NOT EXISTS idx_receipts_status
  ON receipts(status);

-- Fast lookup by freee receipt ID
CREATE INDEX IF NOT EXISTS idx_receipts_freee_id
  ON receipts(freee_receipt_id);

-- Fast audit log lookup
CREATE INDEX IF NOT EXISTS idx_audit_logs_receipt_id
  ON audit_logs(receipt_id, created_at);

-- Fast audit log event type lookup
CREATE INDEX IF NOT EXISTS idx_audit_logs_event_type
  ON audit_logs(event_type, created_at);

-- =============================================================================
-- Initial Data (Optional)
-- =============================================================================
-- No initial data required for this migration
