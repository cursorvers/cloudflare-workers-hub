/**
 * Tests for PHI Detector Service
 */

import { describe, it, expect } from 'vitest';
import {
  detectPHI,
  maskPHI,
  PHIDetectionResult,
  PHIPatternType,
} from './phi-detector';

const getValuesByType = (result: PHIDetectionResult, type: PHIPatternType): string[] =>
  result.detected_patterns
    .filter((pattern) => pattern.type === type)
    .map((pattern) => pattern.value);

describe('PHI Detector', () => {
  it('returns no PHI for empty strings', () => {
    const result = detectPHI('');

    expect(result.contains_phi).toBe(false);
    expect(result.detected_patterns).toEqual([]);
    expect(result.masked_text).toBe('');
    expect(maskPHI('')).toBe('');
  });

  it('handles special characters without false positives', () => {
    const text = '@@@ ### !!!';
    const result = detectPHI(text);

    expect(result.contains_phi).toBe(false);
    expect(result.detected_patterns).toEqual([]);
    expect(result.masked_text).toBe(text);
  });

  it('detects name patterns (First Last, Last, First)', () => {
    const text = 'Patient John Doe met with Doe, Jane for consultation.';
    const result = detectPHI(text);
    const names = getValuesByType(result, 'name');

    expect(result.contains_phi).toBe(true);
    expect(names).toEqual(expect.arrayContaining(['John Doe', 'Doe, Jane']));
    expect(result.masked_text).not.toContain('John Doe');
    expect(result.masked_text).not.toContain('Doe, Jane');
  });

  it('detects date of birth patterns (MM/DD/YYYY, YYYY-MM-DD)', () => {
    const text = 'DOB 01/23/1980 or 1985-12-30 in records.';
    const result = detectPHI(text);
    const dates = getValuesByType(result, 'date_of_birth');

    expect(dates).toEqual(expect.arrayContaining(['01/23/1980', '1985-12-30']));
  });

  it('detects MRN alphanumeric patterns', () => {
    const text = 'MRN: A12B34C is linked to the patient.';
    const result = detectPHI(text);
    const mrns = getValuesByType(result, 'mrn');

    expect(mrns).toEqual(expect.arrayContaining(['MRN: A12B34C']));
  });

  it('detects phone numbers in US formats', () => {
    const text = 'Call (415) 555-1212 or 415-555-1212 for updates.';
    const result = detectPHI(text);
    const phones = getValuesByType(result, 'phone');

    expect(phones).toEqual(expect.arrayContaining(['(415) 555-1212', '415-555-1212']));
  });

  it('detects SSN patterns', () => {
    const text = 'SSN 123-45-6789 should be protected.';
    const result = detectPHI(text);
    const ssns = getValuesByType(result, 'ssn');

    expect(ssns).toEqual(expect.arrayContaining(['123-45-6789']));
  });

  it('detects street addresses with numbers', () => {
    const text = 'Lives at 123 Main Street and visits often.';
    const result = detectPHI(text);
    const addresses = getValuesByType(result, 'address');

    expect(addresses).toEqual(expect.arrayContaining(['123 Main Street']));
  });

  it('detects email addresses', () => {
    const text = 'Reach out via john.doe@example.com for updates.';
    const result = detectPHI(text);
    const emails = getValuesByType(result, 'email');

    expect(emails).toEqual(expect.arrayContaining(['john.doe@example.com']));
  });

  it('masks mixed PHI content consistently', () => {
    const text =
      'John Doe lives at 123 Main Street. Call (415) 555-1212. SSN 123-45-6789. ' +
      'DOB 01/23/1980. MRN: A12B34C. Email john.doe@example.com.';
    const masked = maskPHI(text);

    expect(masked).not.toContain('John Doe');
    expect(masked).not.toContain('123 Main Street');
    expect(masked).not.toContain('(415) 555-1212');
    expect(masked).not.toContain('123-45-6789');
    expect(masked).not.toContain('01/23/1980');
    expect(masked).not.toContain('MRN: A12B34C');
    expect(masked).not.toContain('john.doe@example.com');
    expect(masked).toContain('***');
  });

  it('keeps text unchanged when no PHI is present', () => {
    const text = 'The patient discussed general wellness routines today.';
    const result = detectPHI(text);

    expect(result.contains_phi).toBe(false);
    expect(result.masked_text).toBe(text);
    expect(maskPHI(text)).toBe(text);
  });

  describe('Integration with Reflection API', () => {
    it('detects PHI in reflection text and sets contains_phi flag', () => {
      const reflectionText = 'Patient John Doe discussed treatment at 123 Main Street. Call (415) 555-1212.';
      const result = detectPHI(reflectionText);

      expect(result.contains_phi).toBe(true);
      expect(result.detected_patterns.length).toBeGreaterThan(0);

      // Verify name masking
      const namePatterns = result.detected_patterns.filter(p => p.type === 'name');
      expect(namePatterns.length).toBeGreaterThan(0);
      expect(result.masked_text).not.toContain('John Doe');

      // Verify address masking
      const addressPatterns = result.detected_patterns.filter(p => p.type === 'address');
      expect(addressPatterns.length).toBeGreaterThan(0);
      expect(result.masked_text).not.toContain('123 Main Street');

      // Verify phone masking
      const phonePatterns = result.detected_patterns.filter(p => p.type === 'phone');
      expect(phonePatterns.length).toBeGreaterThan(0);
      expect(result.masked_text).not.toContain('(415) 555-1212');
    });

    it('validates PHI consistency rules for public reflections', () => {
      // Reflection with PHI cannot be public without approval
      const textWithPHI = 'SSN 123-45-6789 discussed during session';
      const result = detectPHI(textWithPHI);

      expect(result.contains_phi).toBe(true);
      const ssnPatterns = result.detected_patterns.filter(p => p.type === 'ssn');
      expect(ssnPatterns.length).toBe(1);
      expect(ssnPatterns[0].value).toBe('123-45-6789');

      // In actual API: is_public=true should be rejected if contains_phi=true && phi_approved=false
      // This test validates the detection logic that enables that rule
    });

    it('handles mixed PHI types in typical reflection scenarios', () => {
      const clinicalReflection =
        'During the session, Dr. Smith discussed patient Jane Doe (DOB 03/15/1975) ' +
        'with medical record number MRN: X789Y12. The patient lives at 456 Oak Avenue ' +
        'and can be reached at jane.doe@email.com or (510) 555-9876.';

      const result = detectPHI(clinicalReflection);

      expect(result.contains_phi).toBe(true);

      // Should detect all PHI types
      const detectedTypes = new Set(result.detected_patterns.map(p => p.type));
      expect(detectedTypes).toContain('name');
      expect(detectedTypes).toContain('date_of_birth');
      expect(detectedTypes).toContain('mrn');
      expect(detectedTypes).toContain('address');
      expect(detectedTypes).toContain('email');
      expect(detectedTypes).toContain('phone');

      // Masked text should not contain any original PHI
      expect(result.masked_text).not.toContain('Jane Doe');
      expect(result.masked_text).not.toContain('03/15/1975');
      expect(result.masked_text).not.toContain('X789Y12');
      expect(result.masked_text).not.toContain('456 Oak Avenue');
      expect(result.masked_text).not.toContain('jane.doe@email.com');
      expect(result.masked_text).not.toContain('(510) 555-9876');
    });

    it('allows safe reflections without PHI to remain public', () => {
      const safeReflection =
        'Today I learned about the importance of mindfulness in daily routines. ' +
        'The discussion focused on general wellness strategies and stress management techniques.';

      const result = detectPHI(safeReflection);

      expect(result.contains_phi).toBe(false);
      expect(result.detected_patterns).toEqual([]);
      expect(result.masked_text).toBe(safeReflection);

      // This reflection can be public without approval
    });
  });
});
