-- Autopilot runtime audit log (WORM-guaranteed)
-- Tracks mode transitions, guard check results, recovery attempts, and budget updates.

CREATE TABLE IF NOT EXISTS autopilot_audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL CHECK(
    event_type IN (
      'mode_transition',
      'guard_check',
      'recovery_attempt',
      'recovery_approved',
      'recovery_denied',
      'budget_update',
      'circuit_breaker_change',
      'heartbeat_stale',
      'auto_stop',
      'alarm_error',
      'task_dlq'
    )
  ),
  previous_mode TEXT,
  new_mode TEXT,
  reason TEXT,
  actor TEXT,
  metadata TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime("now"))
);

-- WORM guarantee: prevent UPDATE and DELETE
CREATE TRIGGER IF NOT EXISTS prevent_autopilot_audit_update
  BEFORE UPDATE ON autopilot_audit_logs
BEGIN
  SELECT RAISE(ABORT, "Autopilot audit log is immutable (WORM guarantee)");
END;

CREATE TRIGGER IF NOT EXISTS prevent_autopilot_audit_delete
  BEFORE DELETE ON autopilot_audit_logs
BEGIN
  SELECT RAISE(ABORT, "Autopilot audit log is immutable (WORM guarantee)");
END;

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_autopilot_audit_event_type
  ON autopilot_audit_logs(event_type, created_at);

CREATE INDEX IF NOT EXISTS idx_autopilot_audit_created_at
  ON autopilot_audit_logs(created_at);
