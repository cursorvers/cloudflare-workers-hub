-- Autopilot Audit Hash Chain
-- Adds SHA-256 hash chain columns for tamper detection.
-- Additive only: existing queries remain compatible.

ALTER TABLE autopilot_audit_logs ADD COLUMN prev_hash TEXT;
ALTER TABLE autopilot_audit_logs ADD COLUMN entry_hash TEXT;
ALTER TABLE autopilot_audit_logs ADD COLUMN chain_version INTEGER DEFAULT 1;

-- Index for chain verification queries (ordered by id ASC)
CREATE INDEX IF NOT EXISTS idx_autopilot_audit_hash_chain
  ON autopilot_audit_logs(entry_hash)
  WHERE entry_hash IS NOT NULL;
