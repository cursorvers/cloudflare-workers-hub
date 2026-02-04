-- Migration: PHI Confidence Scoring (Phase 6.1 + 6.2)
-- Description: Add confidence scoring and AI verification flags to limitless_highlights table
-- Created: 2025-02-03

-- Add phi_confidence_score column (0-100, regex-based detection score)
ALTER TABLE limitless_highlights
ADD COLUMN IF NOT EXISTS phi_confidence_score INTEGER DEFAULT 0 CHECK (phi_confidence_score >= 0 AND phi_confidence_score <= 100);

-- Add needs_ai_verification flag (triggers AI Gateway verification)
ALTER TABLE limitless_highlights
ADD COLUMN IF NOT EXISTS needs_ai_verification BOOLEAN DEFAULT FALSE;

-- Add index for efficient batch processing queries
CREATE INDEX IF NOT EXISTS idx_limitless_highlights_ai_verification
ON limitless_highlights(needs_ai_verification, created_at DESC)
WHERE needs_ai_verification = TRUE;

-- Add index for confidence score queries
CREATE INDEX IF NOT EXISTS idx_limitless_highlights_confidence
ON limitless_highlights(phi_confidence_score DESC)
WHERE phi_confidence_score > 0;

-- Update existing highlights with confidence scores based on detected_phi
-- This is a one-time migration to set initial scores
UPDATE limitless_highlights
SET
  phi_confidence_score = CASE
    WHEN detected_phi = TRUE THEN 80  -- High confidence for existing PHI detections
    ELSE 0
  END,
  needs_ai_verification = CASE
    WHEN detected_phi = TRUE THEN TRUE  -- Existing PHI should be verified
    ELSE FALSE
  END
WHERE phi_confidence_score = 0;  -- Only update rows that haven't been processed

-- Add comment explaining the schema
COMMENT ON COLUMN limitless_highlights.phi_confidence_score IS 'Confidence score (0-100) for PHI detection. Weighted average: (regex × 0.3) + (AI × 0.7)';
COMMENT ON COLUMN limitless_highlights.needs_ai_verification IS 'TRUE if highlight needs AI Gateway verification (confidence 40-90%)';
