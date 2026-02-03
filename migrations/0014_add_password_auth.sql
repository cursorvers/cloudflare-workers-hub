-- Migration: Add password authentication to cockpit_users
--
-- Adds password_hash column for password-based authentication.
-- Existing users (authenticated via Cloudflare Access) will have NULL password_hash.
-- New users can register with password.

-- Add password_hash column (nullable for backwards compatibility)
ALTER TABLE cockpit_users ADD COLUMN password_hash TEXT;

-- Add password reset token support (optional, for future implementation)
ALTER TABLE cockpit_users ADD COLUMN reset_token TEXT;
ALTER TABLE cockpit_users ADD COLUMN reset_token_expires INTEGER;

-- Index for password reset token lookup
CREATE INDEX IF NOT EXISTS idx_users_reset_token ON cockpit_users(reset_token);
