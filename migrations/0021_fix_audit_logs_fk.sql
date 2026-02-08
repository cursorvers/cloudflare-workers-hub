-- Migration 0021: Fix audit_logs foreign key after receipts table rebuild
-- Problem:
--   0017_fix_deal_automation rebuilds `receipts` by renaming the old table to `receipts_backup`
--   and promoting `receipts_new` to `receipts`. SQLite updates FK references on rename,
--   so `audit_logs.receipt_id` ends up referencing `receipts_backup(id)` instead of `receipts(id)`.
-- Impact:
--   Receipt workflow transitions fail with "FOREIGN KEY constraint failed".
-- Fix:
--   Recreate `audit_logs` with FK to `receipts(id)` and copy data.

-- Drop immutable triggers and indexes (they will be recreated).
DROP TRIGGER IF EXISTS prevent_audit_update;
DROP TRIGGER IF EXISTS prevent_audit_delete;
DROP INDEX IF EXISTS idx_audit_logs_receipt_id;
DROP INDEX IF EXISTS idx_audit_logs_event_type;

-- Recreate table with correct FK target.
CREATE TABLE IF NOT EXISTS audit_logs_new (
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
  metadata TEXT,
  user_id TEXT,
  ip_address TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (receipt_id) REFERENCES receipts(id) ON DELETE CASCADE
);

-- Copy existing rows (if any).
INSERT INTO audit_logs_new (
  id,
  receipt_id,
  event_type,
  previous_status,
  new_status,
  metadata,
  user_id,
  ip_address,
  created_at
)
SELECT
  id,
  receipt_id,
  event_type,
  previous_status,
  new_status,
  metadata,
  user_id,
  ip_address,
  created_at
FROM audit_logs;

DROP TABLE audit_logs;
ALTER TABLE audit_logs_new RENAME TO audit_logs;

-- Recreate WORM triggers.
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

-- Recreate indexes.
CREATE INDEX IF NOT EXISTS idx_audit_logs_receipt_id
  ON audit_logs(receipt_id, created_at);

CREATE INDEX IF NOT EXISTS idx_audit_logs_event_type
  ON audit_logs(event_type, created_at);

