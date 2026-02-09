-- Dead Letter Queue for failed receipt processing
-- Tracks receipts that failed classification, upload, or deal creation
-- Supports retry and manual resolution workflows

CREATE TABLE IF NOT EXISTS receipt_dlq (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  receipt_id TEXT,
  error_code TEXT NOT NULL,
  error_message TEXT,
  source_type TEXT DEFAULT 'pdf',
  message_id TEXT,
  attachment_id TEXT,
  retry_count INTEGER DEFAULT 0,
  max_retries INTEGER DEFAULT 3,
  next_retry_at TEXT,
  resolved_at TEXT,
  resolution TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (receipt_id) REFERENCES receipts(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_receipt_dlq_unresolved
  ON receipt_dlq (resolved_at) WHERE resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_receipt_dlq_retry
  ON receipt_dlq (next_retry_at) WHERE resolved_at IS NULL AND retry_count < max_retries;
