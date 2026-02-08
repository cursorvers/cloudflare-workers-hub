-- External OAuth Token Store
-- Created: 2026-02-08
-- Purpose: Move control-plane OAuth tokens out of KV (reduce KV puts, improve durability).

CREATE TABLE IF NOT EXISTS external_oauth_tokens (
  provider TEXT PRIMARY KEY,                 -- e.g. 'freee'
  encrypted_refresh_token TEXT NOT NULL,     -- AES-GCM encrypted + base64 (IV+ciphertext)
  access_token TEXT,                         -- short-lived, optional cache
  access_token_expires_at_ms INTEGER,         -- epoch millis
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

