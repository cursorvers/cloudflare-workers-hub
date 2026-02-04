/**
 * PHI Detector Service (Phase 5)
 * Purpose: Detect and mask protected health information in reflections.
 */

import type { PHIDetectionResult as SchemaPHIDetectionResult } from '../schemas/user-reflections';

export type PHIPatternType =
  | SchemaPHIDetectionResult['detected_patterns'][number]['type']
  | 'ssn';

export interface PHIDetectedPattern {
  type: PHIPatternType;
  value: string;
  confidence: number;
}

export interface PHIDetectionResult
  extends Omit<SchemaPHIDetectionResult, 'detected_patterns'> {
  detected_patterns: PHIDetectedPattern[];
  confidence_score: number; // 0-100
  needs_verification: boolean; // true if confidence < 90%
}

interface PHIPatternDefinition {
  type: PHIPatternType;
  regex: RegExp;
  confidence: number;
}

const PHI_PATTERNS: PHIPatternDefinition[] = [
  {
    type: 'address',
    regex:
      /\b\d{1,5}\s+(?:[A-Za-z0-9.-]+\s){0,4}(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct)\b/gi,
    confidence: 0.7,
  },
  {
    type: 'name',
    // Exclude common medical/general terms
    regex: /\b(?!Patient\s|Doctor\s|Nurse\s|Provider\s|Hospital\s|Clinic\s)[A-Z][a-z]+\s+[A-Z][a-z]+\b/g,
    confidence: 0.6,
  },
  {
    type: 'name',
    regex: /\b[A-Z][a-z]+,\s*[A-Z][a-z]+\b/g,
    confidence: 0.6,
  },
  {
    type: 'date_of_birth',
    regex: /\b(0[1-9]|1[0-2])\/(0[1-9]|[12]\d|3[01])\/\d{4}\b/g,
    confidence: 0.8,
  },
  {
    type: 'date_of_birth',
    regex: /\b\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b/g,
    confidence: 0.8,
  },
  {
    type: 'mrn',
    regex: /\bMRN[:\s-]*[A-Z0-9]{5,12}\b/gi,
    confidence: 0.85,
  },
  {
    type: 'phone',
    regex: /\(\d{3}\)\s?\d{3}-\d{4}/g,
    confidence: 0.7,
  },
  {
    type: 'phone',
    regex: /\b\d{3}-\d{3}-\d{4}\b/g,
    confidence: 0.7,
  },
  {
    type: 'ssn',
    regex: /\b\d{3}-\d{2}-\d{4}\b/g,
    confidence: 0.9,
  },
  {
    type: 'email',
    regex: /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[A-Za-z]{2,}\b/g,
    confidence: 0.75,
  },
];

const DEFAULT_MASK = '***';

const collectMatches = (text: string, pattern: PHIPatternDefinition): PHIDetectedPattern[] => {
  pattern.regex.lastIndex = 0;
  return Array.from(text.matchAll(pattern.regex), (match) => ({
    type: pattern.type,
    value: match[0],
    confidence: pattern.confidence,
  }));
};

/**
 * Pattern type weights for confidence scoring
 * Higher weight = more definitive PHI indicator
 */
const PATTERN_TYPE_WEIGHTS: Record<PHIPatternType, number> = {
  name: 30,
  ssn: 25,
  mrn: 20,
  date_of_birth: 15,
  phone: 10,
  address: 10,
  email: 5,
};

/**
 * Calculate confidence score for PHI detection
 * Score ranges: 0-100
 * - 90+: High confidence (no verification needed)
 * - 50-90: Medium confidence (verification recommended)
 * - <50: Low confidence (verification required)
 */
function calculateConfidence(
  detected_patterns: PHIDetectedPattern[],
  textLength: number
): number {
  if (detected_patterns.length === 0) {
    return 0;
  }

  // Pattern match count contribution (max 50 points)
  // Each pattern adds 15 points, max 3 patterns considered
  const matchCountScore = Math.min(detected_patterns.length * 15, 50);

  // Pattern type weight contribution (max 60 points)
  // Sum of weighted scores based on pattern type and confidence
  const typeWeightScore = detected_patterns.reduce((sum, pattern) => {
    const weight = PATTERN_TYPE_WEIGHTS[pattern.type] || 5;
    return sum + weight * pattern.confidence;
  }, 0);
  const normalizedTypeScore = Math.min(typeWeightScore, 60);

  // Text length penalty (long text = lower confidence due to false positive risk)
  // Penalty kicks in after 200 chars, max penalty: 20 points
  const excessLength = Math.max(0, textLength - 200);
  const lengthPenalty = Math.min(excessLength * 0.05, 20);

  // Final score
  const rawScore = matchCountScore + normalizedTypeScore - lengthPenalty;
  return Math.max(0, Math.min(100, rawScore));
}

/**
 * Detect PHI in text and return matches with masked output.
 * Phase 6.1: Enhanced with confidence scoring for hybrid AI Gateway integration.
 */
export function detectPHI(text: string): PHIDetectionResult {
  if (!text) {
    return {
      contains_phi: false,
      detected_patterns: [],
      masked_text: text,
      confidence_score: 0,
      needs_verification: false,
    };
  }

  const detected_patterns = PHI_PATTERNS.flatMap((pattern) =>
    collectMatches(text, pattern)
  );

  const confidence_score = calculateConfidence(detected_patterns, text.length);
  const needs_verification = detected_patterns.length > 0 && confidence_score < 90;

  return {
    contains_phi: detected_patterns.length > 0,
    detected_patterns,
    masked_text: maskPHI(text),
    confidence_score,
    needs_verification,
  };
}

/**
 * Mask detected PHI content with a standard token.
 */
export function maskPHI(text: string): string {
  if (!text) {
    return text;
  }

  let masked = text;
  for (const pattern of PHI_PATTERNS) {
    // Create new RegExp instance to avoid lastIndex issues
    const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
    masked = masked.replace(regex, DEFAULT_MASK);
  }

  return masked;
}
