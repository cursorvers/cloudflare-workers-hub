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
 * Detect PHI in text and return matches with masked output.
 */
export function detectPHI(text: string): PHIDetectionResult {
  if (!text) {
    return {
      contains_phi: false,
      detected_patterns: [],
      masked_text: text,
    };
  }

  const detected_patterns = PHI_PATTERNS.flatMap((pattern) =>
    collectMatches(text, pattern)
  );

  return {
    contains_phi: detected_patterns.length > 0,
    detected_patterns,
    masked_text: maskPHI(text),
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
