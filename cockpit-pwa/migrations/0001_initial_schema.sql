-- Initial Schema Migration
-- Creates cockpit_tasks table for Kanban Board

CREATE TABLE IF NOT EXISTS cockpit_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'todo' CHECK(status IN ('todo', 'in_progress', 'done', 'blocked')),
  priority TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('low', 'medium', 'high', 'urgent')),
  assignee TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- Git Repositories table
CREATE TABLE IF NOT EXISTS cockpit_git_repos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  branch TEXT NOT NULL DEFAULT 'main',
  last_commit TEXT,
  last_sync INTEGER,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'inactive', 'error')),
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- Alerts table
CREATE TABLE IF NOT EXISTS cockpit_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  severity TEXT NOT NULL DEFAULT 'info' CHECK(severity IN ('info', 'warning', 'error', 'critical')),
  message TEXT NOT NULL,
  source TEXT,
  acknowledged INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);
