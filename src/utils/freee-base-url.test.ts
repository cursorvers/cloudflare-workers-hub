import { describe, expect, it } from 'vitest';

import { DEFAULT_FREEE_BASE_URL, resolveFreeeBaseUrl } from './freee-base-url';

describe('resolveFreeeBaseUrl', () => {
  it('returns the default URL when no override is configured', () => {
    expect(resolveFreeeBaseUrl({} as any)).toBe(DEFAULT_FREEE_BASE_URL);
  });

  it('accepts and normalizes an override in non-production environments', () => {
    expect(
      resolveFreeeBaseUrl({
        ENVIRONMENT: 'development',
        FREEE_BASE_URL: 'https://staging.example.com/api/1/',
      } as any)
    ).toBe('https://staging.example.com/api/1');
  });

  it('ignores overrides in production-like environments', () => {
    expect(
      resolveFreeeBaseUrl({
        ENVIRONMENT: 'production',
        FREEE_BASE_URL: 'https://staging.example.com/api/1',
      } as any)
    ).toBe(DEFAULT_FREEE_BASE_URL);
  });

  it('treats unspecified environments as production-safe by default', () => {
    expect(
      resolveFreeeBaseUrl({
        FREEE_BASE_URL: 'https://staging.example.com/api/1',
      } as any)
    ).toBe(DEFAULT_FREEE_BASE_URL);
  });

  it('rejects invalid non-production overrides', () => {
    expect(() =>
      resolveFreeeBaseUrl({
        ENVIRONMENT: 'development',
        FREEE_BASE_URL: 'http://staging.example.com/api/1',
      } as any)
    ).toThrow('FREEE_BASE_URL must use https');
  });
});
