-- Strategic Advisor Tables
-- FUGUE Strategic Advisor のデータストレージ

-- Plans.md 等のファイル内容を保存
CREATE TABLE IF NOT EXISTS cockpit_files (
    file_path TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Insight フィードバック
CREATE TABLE IF NOT EXISTS cockpit_insight_feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    insight_id TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('accepted', 'dismissed', 'snoozed')),
    feedback TEXT,
    timestamp INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Insight フィードバックのインデックス
CREATE INDEX IF NOT EXISTS idx_insight_feedback_insight_id
ON cockpit_insight_feedback(insight_id);

CREATE INDEX IF NOT EXISTS idx_insight_feedback_timestamp
ON cockpit_insight_feedback(timestamp DESC);

-- Strategic Context キャッシュ（KV の代替/バックアップ）
CREATE TABLE IF NOT EXISTS cockpit_strategic_cache (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    expires_at INTEGER,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
