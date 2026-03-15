-- 0013_essential_scoring.sql
-- Add essential/noise classification to processed_lifelogs
-- Non-destructive: NULL default preserves all existing data

ALTER TABLE processed_lifelogs
  ADD COLUMN IF NOT EXISTS is_essential BOOLEAN DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS essential_score FLOAT DEFAULT NULL;

-- Index for efficient filtering in Obsidian sync queries
CREATE INDEX IF NOT EXISTS idx_processed_lifelogs_essential
  ON processed_lifelogs (is_essential)
  WHERE is_essential IS NOT NULL;

COMMENT ON COLUMN processed_lifelogs.is_essential IS 'true=essential personality-reflecting content, false=noise, NULL=unscored';
COMMENT ON COLUMN processed_lifelogs.essential_score IS '0.0(noise) to 1.0(essential) scoring based on classification, duration, insights, confidence';
