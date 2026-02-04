-- Migration: Add PHI confidence scoring columns (Phase 6.1)
-- Created: 2026-02-03
-- Purpose: Support hybrid PHI detection with confidence scores and AI Gateway verification flags

-- Add confidence scoring columns to lifelog_highlights table
ALTER TABLE lifelog_highlights
ADD COLUMN IF NOT EXISTS phi_confidence_score FLOAT,
ADD COLUMN IF NOT EXISTS needs_ai_verification BOOLEAN DEFAULT FALSE;

-- Add index for AI verification queue queries
CREATE INDEX IF NOT EXISTS idx_lifelog_highlights_needs_verification
ON lifelog_highlights(needs_ai_verification)
WHERE needs_ai_verification = TRUE;

-- Add comment for documentation
COMMENT ON COLUMN lifelog_highlights.phi_confidence_score IS 'PHI detection confidence score (0-100). 90+ = high confidence, 50-90 = medium, <50 = low';
COMMENT ON COLUMN lifelog_highlights.needs_ai_verification IS 'TRUE if confidence < 90%, indicating AI Gateway verification needed';
