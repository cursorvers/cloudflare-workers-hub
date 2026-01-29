-- RBAC Tables Migration
-- Created: 2026-01-29
-- Purpose: JWT authentication and role-based access control for Cockpit API

-- =============================================================================
-- 1. cockpit_users - User Management with Roles
-- =============================================================================
CREATE TABLE cockpit_users (
  user_id TEXT PRIMARY KEY,
  email TEXT UNIQUE,
  role TEXT NOT NULL CHECK(role IN ('admin', 'operator', 'viewer')) DEFAULT 'viewer',
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  is_active INTEGER DEFAULT 1
);

CREATE INDEX idx_users_email ON cockpit_users(email);
CREATE INDEX idx_users_role ON cockpit_users(role);

-- =============================================================================
-- 2. cockpit_refresh_tokens - Refresh Token Storage
-- =============================================================================
CREATE TABLE cockpit_refresh_tokens (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  FOREIGN KEY (user_id) REFERENCES cockpit_users(user_id) ON DELETE CASCADE
);

CREATE INDEX idx_refresh_tokens_user ON cockpit_refresh_tokens(user_id);
CREATE INDEX idx_refresh_tokens_expires ON cockpit_refresh_tokens(expires_at);

-- =============================================================================
-- 3. cockpit_audit_log - Security Audit Trail
-- =============================================================================
CREATE TABLE cockpit_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,
  action TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  method TEXT NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  status TEXT NOT NULL CHECK(status IN ('success', 'denied', 'error')),
  error_message TEXT,
  timestamp INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  FOREIGN KEY (user_id) REFERENCES cockpit_users(user_id) ON DELETE SET NULL
);

CREATE INDEX idx_audit_user ON cockpit_audit_log(user_id);
CREATE INDEX idx_audit_timestamp ON cockpit_audit_log(timestamp DESC);
CREATE INDEX idx_audit_status ON cockpit_audit_log(status);

-- =============================================================================
-- 4. Initial Admin User (CHANGE PASSWORD IMMEDIATELY)
-- =============================================================================
-- Default admin user: admin@cockpit.local / role: admin
-- Generate JWT tokens via /api/cockpit/auth/login endpoint
INSERT INTO cockpit_users (user_id, email, role, is_active)
VALUES ('admin-default', 'admin@cockpit.local', 'admin', 1);

-- =============================================================================
-- 5. Cleanup Trigger for Expired Refresh Tokens
-- =============================================================================
-- This trigger runs on INSERT to automatically clean up expired tokens
CREATE TRIGGER cleanup_expired_refresh_tokens
AFTER INSERT ON cockpit_refresh_tokens
BEGIN
  DELETE FROM cockpit_refresh_tokens
  WHERE expires_at < strftime('%s', 'now');
END;
