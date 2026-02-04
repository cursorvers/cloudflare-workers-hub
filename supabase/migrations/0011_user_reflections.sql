-- Migration: Add user reflections system for Phase 5 (Collaborative Reflection)
-- Purpose: Implement human-in-the-loop reflection workflow with PHI protection
-- Design: Additive-only, extends lifelog_highlights and adds user_reflections
-- Rollback: See rollback section at end of file

BEGIN;

-- ============================================================================
-- Part 1: Extend lifelog_highlights table
-- ============================================================================

-- Add reflection workflow columns
ALTER TABLE lifelog_highlights
  ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending_review' CHECK (
    status IN ('pending_review', 'under_review', 'completed', 'archived')
  ),
  ADD COLUMN IF NOT EXISTS notified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;

-- Create index for pending reviews
CREATE INDEX IF NOT EXISTS idx_highlights_status
  ON lifelog_highlights(status)
  WHERE status IN ('pending_review', 'under_review');

-- Create index for notification scheduling
CREATE INDEX IF NOT EXISTS idx_highlights_notified_at
  ON lifelog_highlights(created_at, notified_at)
  WHERE status = 'pending_review' AND notified_at IS NULL;

-- ============================================================================
-- Part 2: Create user_reflections table
-- ============================================================================

CREATE TABLE user_reflections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Foreign keys
  highlight_id UUID NOT NULL REFERENCES lifelog_highlights(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL, -- Future: auth.uid()

  -- Reflection content
  reflection_text TEXT NOT NULL,
  key_insights TEXT[] DEFAULT '{}'::TEXT[],
  action_items TEXT[] DEFAULT '{}'::TEXT[],

  -- Privacy & PHI protection
  contains_phi BOOLEAN DEFAULT FALSE,
  phi_approved BOOLEAN DEFAULT FALSE,
  is_public BOOLEAN DEFAULT FALSE,

  -- Metadata
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),

  -- Constraints
  CONSTRAINT user_reflections_phi_check CHECK (
    NOT contains_phi OR phi_approved -- If contains PHI, must be approved
  ),
  CONSTRAINT user_reflections_public_check CHECK (
    NOT is_public OR (NOT contains_phi OR phi_approved) -- Public content must not have unapproved PHI
  )
);

-- Indexes
CREATE INDEX idx_reflections_highlight_id ON user_reflections(highlight_id);
CREATE INDEX idx_reflections_user_id ON user_reflections(user_id);
CREATE INDEX idx_reflections_created_at ON user_reflections(created_at DESC);
CREATE INDEX idx_reflections_public ON user_reflections(is_public) WHERE is_public = TRUE;

-- Ensure one reflection per highlight (can be removed if multiple reflections per highlight are allowed)
CREATE UNIQUE INDEX idx_reflections_highlight_unique ON user_reflections(highlight_id);

-- ============================================================================
-- Part 3: RLS (Row Level Security)
-- ============================================================================

ALTER TABLE user_reflections ENABLE ROW LEVEL SECURITY;

-- Policy: Service role has full access
CREATE POLICY "Service role full access"
  ON user_reflections
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Future: User-based policies (commented out for Phase 5 MVP)
-- CREATE POLICY "Users can view own reflections"
--   ON user_reflections
--   FOR SELECT
--   USING (auth.uid()::text = user_id);
--
-- CREATE POLICY "Users can insert own reflections"
--   ON user_reflections
--   FOR INSERT
--   WITH CHECK (auth.uid()::text = user_id);
--
-- CREATE POLICY "Users can update own reflections"
--   ON user_reflections
--   FOR UPDATE
--   USING (auth.uid()::text = user_id)
--   WITH CHECK (auth.uid()::text = user_id);
--
-- CREATE POLICY "Users can view public reflections"
--   ON user_reflections
--   FOR SELECT
--   USING (is_public = TRUE);

-- ============================================================================
-- Part 4: Triggers
-- ============================================================================

-- Trigger: Update updated_at on row modification
CREATE OR REPLACE FUNCTION update_user_reflections_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER user_reflections_updated_at
  BEFORE UPDATE ON user_reflections
  FOR EACH ROW
  EXECUTE FUNCTION update_user_reflections_updated_at();

-- Trigger: Update lifelog_highlights.reviewed_at when reflection is created
CREATE OR REPLACE FUNCTION update_highlight_reviewed_at()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE lifelog_highlights
  SET
    reviewed_at = now(),
    status = 'completed'
  WHERE id = NEW.highlight_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER reflection_marks_highlight_reviewed
  AFTER INSERT ON user_reflections
  FOR EACH ROW
  EXECUTE FUNCTION update_highlight_reviewed_at();

-- ============================================================================
-- Part 5: Comments for documentation
-- ============================================================================

COMMENT ON TABLE user_reflections IS 'Stores user reflections on lifelog highlights with PHI protection';
COMMENT ON COLUMN user_reflections.contains_phi IS 'Auto-detected by PHI detection engine';
COMMENT ON COLUMN user_reflections.phi_approved IS 'User explicitly approved sharing PHI-containing content';
COMMENT ON COLUMN user_reflections.is_public IS 'User chose to make this reflection public';
COMMENT ON COLUMN lifelog_highlights.status IS 'Reflection workflow state: pending_review → under_review → completed → archived';
COMMENT ON COLUMN lifelog_highlights.notified_at IS 'Timestamp when user was notified to review this highlight';
COMMENT ON COLUMN lifelog_highlights.reviewed_at IS 'Timestamp when user completed reflection';

COMMIT;

-- ============================================================================
-- Rollback Instructions
-- ============================================================================

-- To rollback this migration, execute:
--
-- BEGIN;
--
-- -- Drop triggers
-- DROP TRIGGER IF EXISTS reflection_marks_highlight_reviewed ON user_reflections;
-- DROP TRIGGER IF EXISTS user_reflections_updated_at ON user_reflections;
-- DROP FUNCTION IF EXISTS update_highlight_reviewed_at();
-- DROP FUNCTION IF EXISTS update_user_reflections_updated_at();
--
-- -- Drop table
-- DROP TABLE IF EXISTS user_reflections CASCADE;
--
-- -- Remove columns from lifelog_highlights
-- ALTER TABLE lifelog_highlights
--   DROP COLUMN IF EXISTS status,
--   DROP COLUMN IF EXISTS notified_at,
--   DROP COLUMN IF EXISTS reviewed_at;
--
-- -- Drop indexes (cascade will handle these)
-- DROP INDEX IF EXISTS idx_highlights_status;
-- DROP INDEX IF EXISTS idx_highlights_notified_at;
--
-- COMMIT;
