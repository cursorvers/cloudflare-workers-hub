-- Dead Letter Queue for failed receipt processing

CREATE TABLE IF NOT EXISTS receipt_processing_dlq (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,           -- 'gmail' | 'web_scraper'
  original_message TEXT NOT NULL, -- JSON serialized original data
  failure_reason TEXT NOT NULL,   -- Error message
  failure_count INTEGER NOT NULL DEFAULT 1,
  first_failed_at TEXT NOT NULL,
  last_failed_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'retrying' | 'resolved' | 'abandoned'
  resolution_note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_dlq_status ON receipt_processing_dlq(status);
CREATE INDEX idx_dlq_source ON receipt_processing_dlq(source);
CREATE INDEX idx_dlq_last_failed ON receipt_processing_dlq(last_failed_at DESC);
