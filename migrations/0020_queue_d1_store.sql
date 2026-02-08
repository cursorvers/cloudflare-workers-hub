-- Queue Store in D1
-- Created: 2026-02-08
-- Purpose: Move task queue state/results out of KV to reduce KV puts/list usage.

CREATE TABLE IF NOT EXISTS queue_tasks (
  task_id TEXT PRIMARY KEY,
  task_json TEXT NOT NULL,                  -- original task payload (includes queuedAt, etc.)
  status TEXT NOT NULL DEFAULT 'pending',
  priority TEXT NOT NULL DEFAULT 'medium',
  worker_id TEXT,                           -- lease holder
  lease_expires_at_ms INTEGER,              -- epoch millis
  queued_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_queue_tasks_status ON queue_tasks(status);
CREATE INDEX IF NOT EXISTS idx_queue_tasks_lease_expires ON queue_tasks(lease_expires_at_ms);
CREATE INDEX IF NOT EXISTS idx_queue_tasks_queued_at ON queue_tasks(queued_at_ms);

CREATE TABLE IF NOT EXISTS queue_results (
  task_id TEXT PRIMARY KEY,
  result_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);
