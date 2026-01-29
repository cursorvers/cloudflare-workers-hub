-- Push Subscriptions Table Migration
-- Created: 2026-01-29
-- Purpose: Store Web Push notification subscriptions for Cockpit PWA

-- =============================================================================
-- push_subscriptions - Store push notification endpoints
-- =============================================================================
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh_key TEXT NOT NULL,
  auth_key TEXT NOT NULL,
  user_id TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  last_notified INTEGER,
  active INTEGER DEFAULT 1
);

CREATE INDEX idx_push_endpoint ON push_subscriptions(endpoint);
CREATE INDEX idx_push_user ON push_subscriptions(user_id);
CREATE INDEX idx_push_active ON push_subscriptions(active);

-- =============================================================================
-- push_notification_log - Track sent notifications (optional, for debugging)
-- =============================================================================
CREATE TABLE IF NOT EXISTS push_notification_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  severity TEXT CHECK(severity IN ('critical', 'warning', 'info')),
  sent_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  success INTEGER NOT NULL,
  error_message TEXT,
  FOREIGN KEY (subscription_id) REFERENCES push_subscriptions(id) ON DELETE CASCADE
);

CREATE INDEX idx_push_log_sent ON push_notification_log(sent_at DESC);
CREATE INDEX idx_push_log_subscription ON push_notification_log(subscription_id);
