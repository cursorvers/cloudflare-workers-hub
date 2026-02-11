import { describe, expect, it } from 'vitest';

import {
  checkErrorRate,
  DEFAULT_ERROR_RATE_CONFIG,
  validateErrorRateConfig,
} from '../error-rate-monitor';

describe('runtime/error-rate-monitor', () => {
  it('エラー率05%/total=100でOK/none', () => {
    const result = checkErrorRate(5, 100);
    expect(result.severity).toBe('OK');
    expect(result.action).toBe('none');
    expect(result.errorRate).toBe(0.05);
  });

  it('エラー率15%/total=100でCRITICAL/stop', () => {
    const result = checkErrorRate(15, 100);
    expect(result.severity).toBe('CRITICAL');
    expect(result.action).toBe('stop');
    expect(result.errorRate).toBe(0.15);
  });

  it('total < minSamplesでINSUFFICIENT_DATA/skip', () => {
    const result = checkErrorRate(1, 9);
    expect(result.severity).toBe('INSUFFICIENT_DATA');
    expect(result.action).toBe('skip');
  });

  it('errors=0でOK/none', () => {
    const result = checkErrorRate(0, 100);
    expect(result.severity).toBe('OK');
    expect(result.action).toBe('none');
    expect(result.errorRate).toBe(0);
  });

  it('errors=NaNでfail-closed（CRITICAL/stop）', () => {
    const result = checkErrorRate(Number.NaN, 100);
    expect(result.severity).toBe('CRITICAL');
    expect(result.action).toBe('stop');
    expect(result.reason).toContain('fail-closed');
  });

  it('total=0でINSUFFICIENT_DATA/skip（サンプルなし）', () => {
    const result = checkErrorRate(0, 0);
    expect(result.severity).toBe('INSUFFICIENT_DATA');
    expect(result.action).toBe('skip');
    expect(result.errorRate).toBe(0);
  });

  it('カスタム閾値+minSamplesで動作', () => {
    const custom = { errorThreshold: 0.2, minSamples: 20 } as const;
    const skip = checkErrorRate(3, 19, custom);
    const critical = checkErrorRate(4, 20, custom);
    const ok = checkErrorRate(3, 20, custom);

    expect(validateErrorRateConfig(custom)).toBe(true);
    expect(skip.severity).toBe('INSUFFICIENT_DATA');
    expect(skip.action).toBe('skip');
    expect(critical.severity).toBe('CRITICAL');
    expect(critical.action).toBe('stop');
    expect(ok.severity).toBe('OK');
    expect(ok.action).toBe('none');
    expect(DEFAULT_ERROR_RATE_CONFIG.errorThreshold).toBe(0.10);
    expect(DEFAULT_ERROR_RATE_CONFIG.minSamples).toBe(10);
  });

  it('全結果がObject.freeze', () => {
    const ok = checkErrorRate(1, 100);
    const insufficient = checkErrorRate(0, 0);
    const critical = checkErrorRate(20, 100);

    expect(Object.isFrozen(ok)).toBe(true);
    expect(Object.isFrozen(insufficient)).toBe(true);
    expect(Object.isFrozen(critical)).toBe(true);
  });
});
