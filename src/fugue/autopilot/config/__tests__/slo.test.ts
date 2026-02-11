import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SLO_THRESHOLDS,
  checkSloCompliance,
  createSloMetrics,
} from '../slo';

describe('config/slo', () => {
  it('createSloMetrics initializes all values to zero', () => {
    expect(createSloMetrics()).toEqual({
      maxRecursionDepth: 0,
      recoveryRate: 0,
      guardrailViolations: 0,
      p99LatencyMs: 0,
      totalDecisions: 0,
      deniedDecisions: 0,
    });
  });

  it('is compliant when within thresholds', () => {
    const result = checkSloCompliance({
      maxRecursionDepth: 6,
      recoveryRate: 0.995,
      guardrailViolations: 0,
      p99LatencyMs: 5000,
      totalDecisions: 100,
      deniedDecisions: 1,
    });
    expect(result.compliant).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it('detects recursion-depth violation', () => {
    const result = checkSloCompliance({
      ...createSloMetrics(),
      maxRecursionDepth: 7,
      recoveryRate: 0.995,
    });
    expect(result.compliant).toBe(false);
    expect(result.violations).toContain('maxRecursionDepth>6');
  });

  it('detects guardrail violation', () => {
    const result = checkSloCompliance({
      ...createSloMetrics(),
      recoveryRate: 0.995,
      guardrailViolations: 1,
    });
    expect(result.compliant).toBe(false);
    expect(result.violations).toContain('guardrailViolations>0');
  });

  it('detects recovery-rate violation', () => {
    const result = checkSloCompliance({
      ...createSloMetrics(),
      recoveryRate: 0.99,
    });
    expect(result.compliant).toBe(false);
    expect(result.violations).toContain('recoveryRate<0.995');
  });

  it('collects multiple violations', () => {
    const result = checkSloCompliance({
      ...createSloMetrics(),
      maxRecursionDepth: 9,
      recoveryRate: 0.98,
      guardrailViolations: 2,
      p99LatencyMs: 6001,
    });
    expect(result.compliant).toBe(false);
    expect(result.violations).toHaveLength(4);
  });

  it('all exported slo objects are frozen', () => {
    const metrics = createSloMetrics();
    const result = checkSloCompliance({
      ...metrics,
      recoveryRate: 0.995,
    });
    expect(Object.isFrozen(DEFAULT_SLO_THRESHOLDS)).toBe(true);
    expect(Object.isFrozen(metrics)).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
  });
});
