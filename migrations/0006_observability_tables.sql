-- FUGUE Cockpit Observability Tables Migration
-- Created: 2026-01-28
-- Integrates AI provider telemetry from local observability.db

-- =============================================================================
-- 1. cockpit_provider_health - Real-time provider status
-- =============================================================================
CREATE TABLE cockpit_provider_health (
  provider TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK(status IN ('healthy', 'degraded', 'unhealthy', 'unknown')),
  latency_p95_ms INTEGER,
  error_rate REAL,
  last_request_at INTEGER,
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- =============================================================================
-- 2. cockpit_costs - Daily cost aggregation
-- =============================================================================
CREATE TABLE cockpit_costs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  provider TEXT NOT NULL,
  call_count INTEGER DEFAULT 0,
  total_tokens INTEGER DEFAULT 0,
  total_cost_usd REAL DEFAULT 0,
  synced_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  UNIQUE(date, provider)
);

CREATE INDEX idx_costs_date ON cockpit_costs(date DESC);
CREATE INDEX idx_costs_provider ON cockpit_costs(provider);

-- =============================================================================
-- 3. cockpit_observability_requests - Recent request samples (rolling window)
-- =============================================================================
CREATE TABLE cockpit_observability_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,
  provider TEXT NOT NULL,
  agent TEXT,
  latency_ms INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost_usd REAL,
  status TEXT CHECK(status IN ('success', 'error', 'timeout')),
  error_message TEXT
);

CREATE INDEX idx_obs_requests_timestamp ON cockpit_observability_requests(timestamp DESC);
CREATE INDEX idx_obs_requests_provider ON cockpit_observability_requests(provider);

-- =============================================================================
-- 4. cockpit_budget_status - Budget tracking
-- =============================================================================
CREATE TABLE cockpit_budget_status (
  provider TEXT PRIMARY KEY,
  daily_limit_usd REAL,
  daily_spent_usd REAL DEFAULT 0,
  weekly_spent_usd REAL DEFAULT 0,
  monthly_spent_usd REAL DEFAULT 0,
  last_alert_threshold REAL,
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- Initialize providers
INSERT INTO cockpit_provider_health (provider, status) VALUES
  ('claude', 'unknown'),
  ('codex', 'unknown'),
  ('glm', 'unknown'),
  ('gemini', 'unknown'),
  ('manus', 'unknown');

INSERT INTO cockpit_budget_status (provider, daily_limit_usd) VALUES
  ('claude', NULL),  -- Subscription-based
  ('codex', 20.00),
  ('glm', 5.00),
  ('gemini', 5.00),
  ('manus', NULL);   -- Credit-based
