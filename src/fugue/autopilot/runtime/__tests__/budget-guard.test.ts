import { describe, expect, it } from 'vitest';

import {
  checkBudget,
  DEFAULT_THRESHOLDS,
  validateThresholds,
} from '../budget-guard';

describe('runtime/budget-guard', () => {
  it('使用率50%でOK/none', () => {
    const result = checkBudget(50, 100);
    expect(result.severity).toBe('OK');
    expect(result.action).toBe('none');
    expect(result.usageRatio).toBe(0.5);
  });

  it('使用率95%でWARNING/warn', () => {
    const result = checkBudget(95, 100);
    expect(result.severity).toBe('WARNING');
    expect(result.action).toBe('warn');
    expect(result.usageRatio).toBe(0.95);
  });

  it('使用率98%でCRITICAL/stop', () => {
    const result = checkBudget(98, 100);
    expect(result.severity).toBe('CRITICAL');
    expect(result.action).toBe('stop');
    expect(result.usageRatio).toBe(0.98);
  });

  it('使用率100%超でCRITICAL/stop', () => {
    const result = checkBudget(120, 100);
    expect(result.severity).toBe('CRITICAL');
    expect(result.action).toBe('stop');
    expect(result.usageRatio).toBe(1.2);
  });

  it('spent=NaNでfail-closed（CRITICAL/stop）', () => {
    const result = checkBudget(Number.NaN, 100);
    expect(result.severity).toBe('CRITICAL');
    expect(result.action).toBe('stop');
    expect(result.reason).toContain('fail-closed');
  });

  it('limit=0でfail-closed（CRITICAL/stop）', () => {
    const result = checkBudget(50, 0);
    expect(result.severity).toBe('CRITICAL');
    expect(result.action).toBe('stop');
    expect(result.reason).toContain('fail-closed');
  });

  it('カスタム閾値で動作', () => {
    const custom = { warningRatio: 0.7, criticalRatio: 0.8 } as const;
    const warning = checkBudget(75, 100, custom);
    const critical = checkBudget(80, 100, custom);

    expect(validateThresholds(custom)).toBe(true);
    expect(warning.severity).toBe('WARNING');
    expect(warning.action).toBe('warn');
    expect(critical.severity).toBe('CRITICAL');
    expect(critical.action).toBe('stop');
    expect(DEFAULT_THRESHOLDS.warningRatio).toBe(0.95);
  });

  it('全結果がObject.freeze', () => {
    const ok = checkBudget(50, 100);
    const warning = checkBudget(95, 100);
    const critical = checkBudget(98, 100);

    expect(Object.isFrozen(ok)).toBe(true);
    expect(Object.isFrozen(warning)).toBe(true);
    expect(Object.isFrozen(critical)).toBe(true);
  });
});
