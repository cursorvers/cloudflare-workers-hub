import { describe, expect, it } from 'vitest';

import { validateCSRF } from '../csrf-guard';

describe('autopilot/auth/csrf-guard', () => {
  it('許可Originで成功', () => {
    const result = validateCSRF(
      'POST',
      'https://app.example.com',
      null,
      ['https://app.example.com'],
    );

    expect(result.valid).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('不許可Originで失敗（GET はスキップ）', () => {
    const denied = validateCSRF(
      'POST',
      'https://evil.example.com',
      null,
      ['https://app.example.com'],
    );
    const skipped = validateCSRF(
      'GET',
      'https://evil.example.com',
      null,
      ['https://app.example.com'],
    );

    expect(denied.valid).toBe(false);
    expect(skipped.valid).toBe(true);
  });
});
