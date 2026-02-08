-- API Key -> User Mapping Store (control-plane)
-- Created: 2026-02-08
-- Purpose: Move API key mappings out of KV (KV puts on auth path are fragile).

CREATE TABLE IF NOT EXISTS api_key_mappings (
  key_hash TEXT PRIMARY KEY,                 -- first 16 chars of SHA-256
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('service','user')) DEFAULT 'user',
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX IF NOT EXISTS idx_api_key_mappings_user_id ON api_key_mappings(user_id);

