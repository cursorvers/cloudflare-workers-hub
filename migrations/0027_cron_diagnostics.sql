-- Cron execution diagnostics table
-- Records every scheduled handler execution for visibility and debugging.
-- Created: 2026-02-10 (Phase D bugfix: cron runs were invisible)
CREATE TABLE IF NOT EXISTS cron_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('success', 'error', 'skipped')),
  details TEXT,           -- JSON object with job-specific metrics
  error_message TEXT,
  duration_ms INTEGER,
  executed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Index for querying recent runs per job
CREATE INDEX IF NOT EXISTS idx_cron_runs_job_executed
  ON cron_runs(job_name, executed_at DESC);

-- Auto-cleanup: keep 30 days of history (purged by scheduled handler)
-- No automatic TTL in D1 — purge must be done in code.
