-- Kanban Task Management Migration
-- Created: 2026-01-31
--
-- Adds columns for Kanban-style task management:
-- - priority: low, medium, high, urgent
-- - description: detailed task description
-- - Updates status to include kanban columns

-- =============================================================================
-- 1. Add new columns to cockpit_tasks
-- =============================================================================
ALTER TABLE cockpit_tasks ADD COLUMN priority TEXT DEFAULT 'medium';
ALTER TABLE cockpit_tasks ADD COLUMN description TEXT;

-- =============================================================================
-- 2. Create new table with updated CHECK constraint
-- (SQLite doesn't support ALTER CONSTRAINT, so we recreate)
-- =============================================================================
CREATE TABLE cockpit_tasks_new (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('backlog', 'pending', 'in_progress', 'review', 'completed', 'failed', 'running')) DEFAULT 'backlog',
  executor TEXT CHECK(executor IN ('claude-code', 'codex', 'glm', 'subagent', 'gemini')),
  priority TEXT CHECK(priority IN ('low', 'medium', 'high', 'urgent')) DEFAULT 'medium',
  description TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  logs TEXT,
  result TEXT
);

-- Copy data from old table
INSERT INTO cockpit_tasks_new (id, title, status, executor, priority, description, created_at, updated_at, logs, result)
SELECT
  id,
  title,
  CASE status
    WHEN 'running' THEN 'in_progress'
    ELSE status
  END,
  executor,
  COALESCE(priority, 'medium'),
  description,
  created_at,
  updated_at,
  logs,
  result
FROM cockpit_tasks;

-- Drop old table and rename new one
DROP TABLE cockpit_tasks;
ALTER TABLE cockpit_tasks_new RENAME TO cockpit_tasks;

-- Recreate indexes
CREATE INDEX idx_tasks_status ON cockpit_tasks(status);
CREATE INDEX idx_tasks_created ON cockpit_tasks(created_at DESC);
CREATE INDEX idx_tasks_priority ON cockpit_tasks(priority);
