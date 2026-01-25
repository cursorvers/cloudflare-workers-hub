-- Phase 3: Scheduled Tasks (Cron) Table
-- Stores scheduled tasks for periodic execution

CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  cron_expression TEXT NOT NULL,
  task_type TEXT NOT NULL DEFAULT 'custom',
  task_content TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at TEXT,
  next_run_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Index for querying user's tasks
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_user_id ON scheduled_tasks(user_id);

-- Index for querying due tasks efficiently
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_due ON scheduled_tasks(enabled, next_run_at);

-- Index for querying tasks by type
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_type ON scheduled_tasks(task_type);
