-- Conversation Memory Schema
-- Phase 1: 永続メモリ機能

-- 会話履歴テーブル
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'slack',
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  metadata TEXT, -- JSON
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME -- NULL = 永続
);

-- ユーザー設定テーブル
CREATE TABLE IF NOT EXISTS user_preferences (
  user_id TEXT PRIMARY KEY,
  display_name TEXT,
  timezone TEXT DEFAULT 'Asia/Tokyo',
  language TEXT DEFAULT 'ja',
  preferences TEXT, -- JSON (通知設定、フォーマット等)
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- スケジュールタスクテーブル (Phase 3用に先行作成)
CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  cron_expression TEXT NOT NULL,
  task_type TEXT NOT NULL,
  task_content TEXT NOT NULL,
  enabled INTEGER DEFAULT 1,
  last_run_at DATETIME,
  next_run_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- インデックス
CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_channel ON conversations(channel, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_scheduled_next_run ON scheduled_tasks(next_run_at) WHERE enabled = 1;
