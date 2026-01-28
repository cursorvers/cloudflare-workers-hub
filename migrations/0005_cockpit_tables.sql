-- FUGUE Cockpit Tables Migration
-- Created: 2026-01-28

-- =============================================================================
-- 1. cockpit_tasks - Task Management
-- =============================================================================
CREATE TABLE cockpit_tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running', 'pending', 'completed', 'failed')),
  executor TEXT CHECK(executor IN ('claude-code', 'codex', 'glm', 'subagent', 'gemini')),
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  logs TEXT,
  result TEXT
);

CREATE INDEX idx_tasks_status ON cockpit_tasks(status);
CREATE INDEX idx_tasks_created ON cockpit_tasks(created_at DESC);

-- =============================================================================
-- 2. cockpit_git_repos - Git Repository State
-- =============================================================================
CREATE TABLE cockpit_git_repos (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  branch TEXT,
  status TEXT CHECK(status IN ('clean', 'dirty', 'ahead', 'behind', 'diverged')),
  uncommitted_count INTEGER DEFAULT 0,
  ahead_count INTEGER DEFAULT 0,
  behind_count INTEGER DEFAULT 0,
  last_checked INTEGER,
  modified_files TEXT
);

-- =============================================================================
-- 3. cockpit_alerts - Alert Integration
-- =============================================================================
CREATE TABLE cockpit_alerts (
  id TEXT PRIMARY KEY,
  severity TEXT NOT NULL CHECK(severity IN ('critical', 'warning', 'info')),
  title TEXT NOT NULL,
  message TEXT,
  source TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  acknowledged INTEGER DEFAULT 0
);

CREATE INDEX idx_alerts_severity ON cockpit_alerts(severity);
CREATE INDEX idx_alerts_created ON cockpit_alerts(created_at DESC);
