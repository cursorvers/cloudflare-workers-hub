import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  sanitizeUntrusted,
  validateTrustedConfig,
  validateUserIntent,
  wrapAsTainted,
} from '../schemas/trust-validation';
import { TRUST_ZONES } from '../types/trust-boundary';

afterEach(() => {
  vi.useRealTimers();
});

describe('schemas/trust-validation', () => {
  describe('validateTrustedConfig', () => {
    it('accepts a non-empty string', () => {
      const result = validateTrustedConfig('ok');
      expect(result.success).toBe(true);
      if (!result.success) throw new Error('Expected validation success');
      expect(result.data).toBe('ok');
    });

    it('rejects an empty string', () => {
      const result = validateTrustedConfig('');
      expect(result.success).toBe(false);
      if (result.success) throw new Error('Expected validation failure');
      expect(result.error).toContain('Config must not be empty');
    });

    it('rejects strings over the maximum length', () => {
      const tooLong = 'a'.repeat(10_001);
      const result = validateTrustedConfig(tooLong);
      expect(result.success).toBe(false);
      if (result.success) throw new Error('Expected validation failure');
      expect(result.error).toContain('Config exceeds maximum length');
    });
  });

  describe('validateUserIntent', () => {
    it('accepts a non-empty string', () => {
      const result = validateUserIntent('do the thing');
      expect(result.success).toBe(true);
      if (!result.success) throw new Error('Expected validation success');
      expect(result.data).toBe('do the thing');
    });

    it('rejects an empty string', () => {
      const result = validateUserIntent('');
      expect(result.success).toBe(false);
      if (result.success) throw new Error('Expected validation failure');
      expect(result.error).toContain('Intent must not be empty');
    });

    it('rejects strings over the maximum length', () => {
      const tooLong = 'a'.repeat(5_001);
      const result = validateUserIntent(tooLong);
      expect(result.success).toBe(false);
      if (result.success) throw new Error('Expected validation failure');
      expect(result.error).toContain('Intent exceeds maximum length');
    });
  });

  describe('sanitizeUntrusted', () => {
    it('returns the input when no control characters are present', () => {
      const result = sanitizeUntrusted('hello world');
      expect(result.success).toBe(true);
      if (!result.success) throw new Error('Expected sanitize success');
      expect(result.data).toBe('hello world');
    });

    it('strips disallowed control characters but preserves newline and tab', () => {
      const input = `a\u0000b\u0008c\u000Bd\u000Ce\u000Ef\u007Fg\n\tend`;
      const result = sanitizeUntrusted(input);
      expect(result.success).toBe(true);
      if (!result.success) throw new Error('Expected sanitize success');

      // Removed: NUL(0x00), BS(0x08), VT(0x0B), FF(0x0C), SO(0x0E), DEL(0x7F)
      // Kept: LF(\n), TAB(\t)
      expect(result.data).toBe('abcdefg\n\tend');
    });

    it('rejects strings over the maximum length', () => {
      const tooLong = 'a'.repeat(50_001);
      const result = sanitizeUntrusted(tooLong);
      expect(result.success).toBe(false);
      if (result.success) throw new Error('Expected sanitize failure');
      expect(result.error).toContain('Input exceeds maximum length');
    });
  });

  describe('wrapAsTainted', () => {
    it('wraps data with a non-promotable frozen taint label', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-02-11T12:34:56.789Z'));

      const payload = { key: 'value' };
      const wrapped = wrapAsTainted(payload, 'unit-test', 'trace-123');

      expect(Object.isFrozen(wrapped)).toBe(true);
      expect(Object.isFrozen(wrapped.taint)).toBe(true);

      expect(wrapped.data).toBe(payload);
      expect(wrapped.promotable).toBe(false);

      expect(wrapped.taint).toEqual({
        source: 'unit-test',
        zone: TRUST_ZONES.EXTERNAL_UNTRUSTED,
        timestamp: '2026-02-11T12:34:56.789Z',
        traceId: 'trace-123',
      });

      // Ensure the wrapper cannot be mutated.
      expect(() => {
        (wrapped as unknown as { promotable: boolean }).promotable = true;
      }).toThrow();
    });
  });
});
