-- Migration: Add lifelog_highlights table for Phase 1 (Timestamp Highlights)
-- Purpose: Store user-marked highlights with ±30s context extraction
-- Design: Additive-only, no changes to existing tables
-- Rollback: DROP TABLE lifelog_highlights CASCADE;

BEGIN;

-- Create highlights table
CREATE TABLE lifelog_highlights (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Foreign keys
  lifelog_id UUID REFERENCES processed_lifelogs(id) ON DELETE CASCADE,
  limitless_id TEXT NOT NULL, -- Direct reference to Limitless API

  -- Timestamp information
  highlight_time TIMESTAMPTZ NOT NULL, -- User-marked moment
  start_time TIMESTAMPTZ NOT NULL, -- highlight_time - 30s
  end_time TIMESTAMPTZ NOT NULL, -- highlight_time + 30s

  -- Extracted content
  extracted_text TEXT, -- Transcription of ±30s window
  speaker_name TEXT, -- Primary speaker in this segment
  topics JSONB DEFAULT '[]'::jsonb, -- Topics identified in this segment

  -- Processing state (from Codex recommendation)
  processing_status TEXT DEFAULT 'pending' CHECK (
    processing_status IN ('pending', 'processing', 'completed', 'failed')
  ),
  error_message TEXT, -- Error details on failure
  retry_count INTEGER DEFAULT 0,

  -- Metadata
  trigger_source TEXT DEFAULT 'ios_shortcut',
  processed_at TIMESTAMPTZ,

  -- Phase 4: User reflections (optional - NULL allowed)
  user_reflection TEXT, -- Optional: "How did this make you feel?"
  user_action_plan TEXT, -- Optional: "How will you apply this to your work?"

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Indexes for performance
CREATE INDEX idx_highlights_lifelog_id ON lifelog_highlights(lifelog_id);
CREATE INDEX idx_highlights_limitless_id ON lifelog_highlights(limitless_id);
CREATE INDEX idx_highlights_time ON lifelog_highlights(highlight_time);
CREATE INDEX idx_highlights_processing_status ON lifelog_highlights(processing_status)
  WHERE processing_status IN ('pending', 'failed');

-- RLS (Row Level Security)
ALTER TABLE lifelog_highlights ENABLE ROW LEVEL SECURITY;

-- RLS Policy: Allow all operations for service role
-- Rationale: This application uses service role key for all DB operations
-- No user-based authentication in Phase 1 (single-user system)
CREATE POLICY "Allow all operations for service role"
ON lifelog_highlights
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

-- Add updated_at trigger
CREATE OR REPLACE FUNCTION update_lifelog_highlights_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER lifelog_highlights_updated_at
  BEFORE UPDATE ON lifelog_highlights
  FOR EACH ROW
  EXECUTE FUNCTION update_lifelog_highlights_updated_at();

COMMIT;
