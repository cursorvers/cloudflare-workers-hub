-- Migration 0029: Harden finance tenant boundaries for freee tokens and audit logs
-- Purpose:
--   1. Scope external_oauth_tokens by tenant_id + provider + company_id
--   2. Rebuild audit_logs as tenant-aware append-only records without ON DELETE CASCADE

PRAGMA foreign_keys = OFF;

DROP TRIGGER IF EXISTS prevent_audit_update;
DROP TRIGGER IF EXISTS prevent_audit_delete;
DROP INDEX IF EXISTS idx_audit_logs_receipt_id;
DROP INDEX IF EXISTS idx_audit_logs_event_type;
DROP INDEX IF EXISTS idx_audit_logs_tenant;

CREATE TABLE IF NOT EXISTS audit_logs_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
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
  FOREIGN KEY (receipt_id) REFERENCES receipts(id) ON DELETE RESTRICT
);

INSERT INTO audit_logs_new (
  id,
  tenant_id,
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
  audit_logs.id,
  COALESCE(receipts.tenant_id, 'default'),
  audit_logs.receipt_id,
  audit_logs.event_type,
  audit_logs.previous_status,
  audit_logs.new_status,
  audit_logs.metadata,
  audit_logs.user_id,
  audit_logs.ip_address,
  audit_logs.created_at
FROM audit_logs
LEFT JOIN receipts ON receipts.id = audit_logs.receipt_id;

DROP TABLE audit_logs;
ALTER TABLE audit_logs_new RENAME TO audit_logs;

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

CREATE INDEX IF NOT EXISTS idx_audit_logs_receipt_id
  ON audit_logs(tenant_id, receipt_id, created_at);

CREATE INDEX IF NOT EXISTS idx_audit_logs_event_type
  ON audit_logs(tenant_id, event_type, created_at);

CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant
  ON audit_logs(tenant_id, created_at);

DROP INDEX IF EXISTS idx_external_oauth_tokens_provider;

CREATE TABLE IF NOT EXISTS migration_guard (
  ok INTEGER NOT NULL CHECK (ok = 1)
);

INSERT INTO migration_guard(ok)
SELECT CASE
  WHEN EXISTS (SELECT 1 FROM external_oauth_tokens)
   AND (
     SELECT COUNT(DISTINCT tenant_id)
     FROM tenant_users
     WHERE is_active = 1
   ) > 1
  THEN 0
  ELSE 1
END;

DROP TABLE migration_guard;

CREATE TABLE IF NOT EXISTS external_oauth_tokens_new (
  tenant_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  company_id TEXT NOT NULL DEFAULT '',
  encrypted_refresh_token TEXT NOT NULL,
  access_token TEXT,
  access_token_expires_at_ms INTEGER,
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (tenant_id, provider, company_id)
);

INSERT INTO external_oauth_tokens_new (
  tenant_id,
  provider,
  company_id,
  encrypted_refresh_token,
  access_token,
  access_token_expires_at_ms,
  updated_at
)
SELECT
  'default',
  provider,
  COALESCE(company_id, ''),
  encrypted_refresh_token,
  access_token,
  access_token_expires_at_ms,
  updated_at
FROM external_oauth_tokens;

DROP TABLE external_oauth_tokens;
ALTER TABLE external_oauth_tokens_new RENAME TO external_oauth_tokens;

CREATE INDEX IF NOT EXISTS idx_external_oauth_tokens_tenant
  ON external_oauth_tokens(tenant_id, provider, updated_at DESC);

PRAGMA foreign_keys = ON;
