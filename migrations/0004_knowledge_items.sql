-- Knowledge Items Table
-- Stores metadata for knowledge base items with full-text search
-- R2 stores actual content, D1 stores searchable metadata

-- Main knowledge items metadata table
CREATE TABLE IF NOT EXISTS knowledge_items (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  source TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT,
  content_preview TEXT,
  r2_path TEXT NOT NULL,
  audio_path TEXT,
  vectorize_id TEXT,
  language TEXT NOT NULL DEFAULT 'ja',
  duration_seconds INTEGER,
  word_count INTEGER,
  tags TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  synced_at TEXT
);

-- Full-text search virtual table
CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
  title,
  content_preview,
  tags,
  content='knowledge_items',
  content_rowid='rowid'
);

-- Index for common queries
CREATE INDEX IF NOT EXISTS idx_knowledge_user_source ON knowledge_items(user_id, source);
CREATE INDEX IF NOT EXISTS idx_knowledge_type ON knowledge_items(type);
CREATE INDEX IF NOT EXISTS idx_knowledge_created ON knowledge_items(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_knowledge_language ON knowledge_items(language);

-- Triggers to keep FTS in sync with main table
CREATE TRIGGER IF NOT EXISTS knowledge_ai AFTER INSERT ON knowledge_items BEGIN
  INSERT INTO knowledge_fts(rowid, title, content_preview, tags)
  VALUES (new.rowid, new.title, new.content_preview, new.tags);
END;

CREATE TRIGGER IF NOT EXISTS knowledge_ad AFTER DELETE ON knowledge_items BEGIN
  INSERT INTO knowledge_fts(knowledge_fts, rowid, title, content_preview, tags)
  VALUES('delete', old.rowid, old.title, old.content_preview, old.tags);
END;

CREATE TRIGGER IF NOT EXISTS knowledge_au AFTER UPDATE ON knowledge_items BEGIN
  INSERT INTO knowledge_fts(knowledge_fts, rowid, title, content_preview, tags)
  VALUES('delete', old.rowid, old.title, old.content_preview, old.tags);
  INSERT INTO knowledge_fts(rowid, title, content_preview, tags)
  VALUES (new.rowid, new.title, new.content_preview, new.tags);
END;
