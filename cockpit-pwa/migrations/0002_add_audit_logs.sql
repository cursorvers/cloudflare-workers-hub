-- Migration: Add Audit Logs Table
-- Phase 3: Track all data modifications for compliance

CREATE TABLE IF NOT EXISTS cockpit_audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  changes TEXT,
  ip_address TEXT,
  user_agent TEXT,
  created_at INTEGER NOT NULL
);

-- Index for efficient querying by user
CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON cockpit_audit_logs(user_id);

-- Index for efficient querying by entity
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON cockpit_audit_logs(entity_type, entity_id);

-- Index for efficient querying by timestamp
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON cockpit_audit_logs(created_at);
