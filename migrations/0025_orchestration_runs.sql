-- 0025_orchestration_runs.sql
-- FUGUE Persistent Orchestration API - Run/Step/CostEvent tables
-- Created: 2026-02-09
-- PSCSR: 3 rounds CONDITIONAL APPROVED

-- =============================================================================
-- 1. runs - Orchestration run state
-- =============================================================================
CREATE TABLE runs (
  run_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  instruction TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','running','succeeded','failed','blocked_error','cancelled')),
  budget_usd REAL NOT NULL DEFAULT 10.0,
  cost_usd REAL NOT NULL DEFAULT 0.0,
  memory_json TEXT DEFAULT '{}',
  step_count INTEGER NOT NULL DEFAULT 0,
  max_steps INTEGER NOT NULL DEFAULT 20,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- =============================================================================
-- 2. steps - Step-by-step execution within a run
-- =============================================================================
CREATE TABLE steps (
  step_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  seq INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','running','succeeded','failed','blocked','skipped')),
  agent TEXT NOT NULL,
  input_ref TEXT,
  output_ref TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  idempotency_key TEXT UNIQUE,
  cost_usd REAL NOT NULL DEFAULT 0.0,
  started_at DATETIME,
  completed_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- =============================================================================
-- 3. cost_events - Fine-grained provider/model usage events
-- =============================================================================
CREATE TABLE cost_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  step_id TEXT REFERENCES steps(step_id),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  usd REAL NOT NULL DEFAULT 0.0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- =============================================================================
-- Indexes
-- =============================================================================
CREATE INDEX idx_runs_owner_status ON runs(owner_id, status);
CREATE INDEX idx_runs_created ON runs(created_at);

CREATE INDEX idx_steps_run_seq ON steps(run_id, seq);
CREATE INDEX idx_steps_status ON steps(run_id, status);
CREATE INDEX idx_steps_idempotency ON steps(idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE INDEX idx_cost_events_run ON cost_events(run_id);
CREATE INDEX idx_cost_events_step ON cost_events(step_id);
