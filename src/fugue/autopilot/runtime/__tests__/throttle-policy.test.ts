import { describe, expect, it } from 'vitest';

import {
  computeThrottle,
  applyOverride,
  DEFAULT_THROTTLE_CONFIG,
  type ThrottleLevel,
  type ThrottleOverride,
  type ThrottleConfig,
} from '../throttle-policy';
import type { BudgetPrediction } from '../budget-predictor';
import type { BudgetSeverity } from '../budget-guard';

// =============================================================================
// Helpers
// =============================================================================

function makePrediction(overrides: Partial<BudgetPrediction> = {}): BudgetPrediction {
  return Object.freeze({
    method: 'hybrid' as const,
    timeToExhaustMs: -1,
    exhaustionTimestamp: 0,
    spendRate: 0,
    confidence: 0.8,
    currentRatio: 0.5,
    limit: 100,
    spent: 50,
    sampleCount: 10,
    ...overrides,
  });
}

// =============================================================================
// computeThrottle — ratio axis
// =============================================================================

describe('throttle-policy/computeThrottle (ratio axis)', () => {
  it('NONE when ratio is low', () => {
    const result = computeThrottle(makePrediction({ currentRatio: 0.5 }), 'OK');
    expect(result.level).toBe('NONE');
    expect(result.rate).toBe(1.0);
    expect(result.axes.ratio.level).toBe('NONE');
  });

  it('LIGHT when ratio >= 0.90', () => {
    const result = computeThrottle(makePrediction({ currentRatio: 0.91 }), 'OK');
    expect(result.level).toBe('LIGHT');
    expect(result.rate).toBe(0.7);
    expect(result.axes.ratio.level).toBe('LIGHT');
  });

  it('HEAVY when ratio >= 0.95', () => {
    const result = computeThrottle(makePrediction({ currentRatio: 0.96 }), 'OK');
    expect(result.level).toBe('HEAVY');
    expect(result.rate).toBe(0.4);
    expect(result.axes.ratio.level).toBe('HEAVY');
  });

  it('STOPPED when ratio >= 0.98', () => {
    const result = computeThrottle(makePrediction({ currentRatio: 0.99 }), 'OK');
    expect(result.level).toBe('STOPPED');
    expect(result.rate).toBe(0.0);
    expect(result.axes.ratio.level).toBe('STOPPED');
  });

  it('boundary: exactly 0.90 is LIGHT', () => {
    const result = computeThrottle(makePrediction({ currentRatio: 0.90 }), 'OK');
    expect(result.level).toBe('LIGHT');
  });

  it('boundary: exactly 0.95 is HEAVY', () => {
    const result = computeThrottle(makePrediction({ currentRatio: 0.95 }), 'OK');
    expect(result.level).toBe('HEAVY');
  });

  it('boundary: exactly 0.98 is STOPPED', () => {
    const result = computeThrottle(makePrediction({ currentRatio: 0.98 }), 'OK');
    expect(result.level).toBe('STOPPED');
  });
});

// =============================================================================
// computeThrottle — time axis
// =============================================================================

describe('throttle-policy/computeThrottle (time axis)', () => {
  const MS_HOUR = 3_600_000;

  it('NONE when no exhaustion predicted (timeToExhaustMs = -1)', () => {
    const result = computeThrottle(
      makePrediction({ currentRatio: 0.5, timeToExhaustMs: -1, confidence: 0.9 }),
      'OK',
    );
    expect(result.axes.time.level).toBe('NONE');
  });

  it('NONE when confidence below threshold', () => {
    const result = computeThrottle(
      makePrediction({ currentRatio: 0.5, timeToExhaustMs: 1000, confidence: 0.1 }),
      'OK',
    );
    expect(result.axes.time.level).toBe('NONE');
  });

  it('LIGHT when timeToExhaust <= 24h', () => {
    const result = computeThrottle(
      makePrediction({ currentRatio: 0.5, timeToExhaustMs: 20 * MS_HOUR, confidence: 0.8 }),
      'OK',
    );
    expect(result.axes.time.level).toBe('LIGHT');
  });

  it('HEAVY when timeToExhaust <= 6h', () => {
    const result = computeThrottle(
      makePrediction({ currentRatio: 0.5, timeToExhaustMs: 5 * MS_HOUR, confidence: 0.8 }),
      'OK',
    );
    expect(result.axes.time.level).toBe('HEAVY');
  });

  it('STOPPED when timeToExhaust <= 1h', () => {
    const result = computeThrottle(
      makePrediction({ currentRatio: 0.5, timeToExhaustMs: 30 * 60_000, confidence: 0.8 }),
      'OK',
    );
    expect(result.axes.time.level).toBe('STOPPED');
  });

  it('NONE when timeToExhaust > 24h', () => {
    const result = computeThrottle(
      makePrediction({ currentRatio: 0.5, timeToExhaustMs: 48 * MS_HOUR, confidence: 0.8 }),
      'OK',
    );
    expect(result.axes.time.level).toBe('NONE');
  });
});

// =============================================================================
// computeThrottle — severity floor
// =============================================================================

describe('throttle-policy/computeThrottle (severity floor)', () => {
  it('OK severity floor is NONE', () => {
    const result = computeThrottle(makePrediction({ currentRatio: 0.5 }), 'OK');
    expect(result.axes.severityFloor.level).toBe('NONE');
  });

  it('WARNING severity guarantees at least LIGHT', () => {
    const result = computeThrottle(makePrediction({ currentRatio: 0.5 }), 'WARNING');
    expect(result.level).toBe('LIGHT');
    expect(result.rate).toBe(0.7);
    expect(result.axes.selectedBy).toBe('severity_floor');
  });

  it('CRITICAL severity guarantees at least HEAVY', () => {
    const result = computeThrottle(makePrediction({ currentRatio: 0.5 }), 'CRITICAL');
    expect(result.level).toBe('HEAVY');
    expect(result.rate).toBe(0.4);
    expect(result.axes.selectedBy).toBe('severity_floor');
  });

  it('severity floor does not override stricter ratio', () => {
    // Ratio → STOPPED (0.99), severity floor → LIGHT (WARNING)
    const result = computeThrottle(makePrediction({ currentRatio: 0.99 }), 'WARNING');
    expect(result.level).toBe('STOPPED');
    expect(result.axes.selectedBy).toBe('ratio');
  });
});

// =============================================================================
// computeThrottle — selectedBy
// =============================================================================

describe('throttle-policy/computeThrottle (selectedBy)', () => {
  it('selectedBy = ratio when ratio is strictest', () => {
    const result = computeThrottle(
      makePrediction({ currentRatio: 0.96, timeToExhaustMs: -1 }),
      'OK',
    );
    expect(result.axes.selectedBy).toBe('ratio');
  });

  it('selectedBy = time when time is strictest', () => {
    const MS_HOUR = 3_600_000;
    const result = computeThrottle(
      makePrediction({ currentRatio: 0.5, timeToExhaustMs: 30 * 60_000, confidence: 0.8 }),
      'OK',
    );
    expect(result.axes.selectedBy).toBe('time');
  });

  it('selectedBy = severity_floor when floor is strictest', () => {
    const result = computeThrottle(
      makePrediction({ currentRatio: 0.5, timeToExhaustMs: -1 }),
      'CRITICAL',
    );
    expect(result.axes.selectedBy).toBe('severity_floor');
  });
});

// =============================================================================
// computeThrottle — fail-closed
// =============================================================================

describe('throttle-policy/computeThrottle (fail-closed)', () => {
  it('STOPPED on NaN currentRatio', () => {
    const result = computeThrottle(
      makePrediction({ currentRatio: NaN }),
      'OK',
    );
    expect(result.level).toBe('STOPPED');
    expect(result.rate).toBe(0.0);
  });

  it('STOPPED on Infinity currentRatio', () => {
    const result = computeThrottle(
      makePrediction({ currentRatio: Infinity }),
      'OK',
    );
    expect(result.level).toBe('STOPPED');
    expect(result.rate).toBe(0.0);
  });

  it('STOPPED on NaN timeToExhaustMs', () => {
    const result = computeThrottle(
      makePrediction({ timeToExhaustMs: NaN }),
      'OK',
    );
    expect(result.level).toBe('STOPPED');
    expect(result.rate).toBe(0.0);
  });

  it('STOPPED on NaN confidence', () => {
    const result = computeThrottle(
      makePrediction({ confidence: NaN }),
      'OK',
    );
    expect(result.level).toBe('STOPPED');
    expect(result.rate).toBe(0.0);
  });
});

// =============================================================================
// computeThrottle — UI status
// =============================================================================

describe('throttle-policy/computeThrottle (ui)', () => {
  it('NONE produces normal tone', () => {
    const result = computeThrottle(makePrediction({ currentRatio: 0.5 }), 'OK');
    expect(result.ui.tone).toBe('normal');
    expect(result.ui.badge).toBe('NONE');
  });

  it('LIGHT produces caution tone', () => {
    const result = computeThrottle(makePrediction({ currentRatio: 0.91 }), 'OK');
    expect(result.ui.tone).toBe('caution');
  });

  it('HEAVY produces warning tone', () => {
    const result = computeThrottle(makePrediction({ currentRatio: 0.96 }), 'OK');
    expect(result.ui.tone).toBe('warning');
  });

  it('STOPPED produces critical tone', () => {
    const result = computeThrottle(makePrediction({ currentRatio: 0.99 }), 'OK');
    expect(result.ui.tone).toBe('critical');
  });
});

// =============================================================================
// applyOverride
// =============================================================================

describe('throttle-policy/applyOverride', () => {
  const baseState = computeThrottle(makePrediction({ currentRatio: 0.96 }), 'OK');

  it('BYPASS sets level to NONE', () => {
    const override: ThrottleOverride = {
      action: 'BYPASS',
      expiresAt: 0,
      reason: 'false positive',
      approvedBy: 'admin@example.com',
    };
    const result = applyOverride(baseState, override, 1000);
    expect(result.level).toBe('NONE');
    expect(result.rate).toBe(1.0);
    expect(result.override).toEqual(override);
    expect(result.axes.selectedBy).toBe('override');
  });

  it('FORCE_LEVEL sets specific level', () => {
    const override: ThrottleOverride = {
      action: 'FORCE_LEVEL',
      forceLevel: 'LIGHT',
      expiresAt: 0,
      reason: 'manual adjustment',
      approvedBy: 'admin@example.com',
    };
    const result = applyOverride(baseState, override, 1000);
    expect(result.level).toBe('LIGHT');
    expect(result.rate).toBe(0.7);
  });

  it('expired override is ignored', () => {
    const override: ThrottleOverride = {
      action: 'BYPASS',
      expiresAt: 5000,
      reason: 'temporary bypass',
      approvedBy: 'admin@example.com',
    };
    // nowMs (6000) >= expiresAt (5000) → expired
    const result = applyOverride(baseState, override, 6000);
    expect(result.level).toBe(baseState.level);
    expect(result.override).toBe(baseState.override);
  });

  it('non-expired override is applied', () => {
    const override: ThrottleOverride = {
      action: 'BYPASS',
      expiresAt: 10000,
      reason: 'valid bypass',
      approvedBy: 'admin@example.com',
    };
    // nowMs (5000) < expiresAt (10000) → valid
    const result = applyOverride(baseState, override, 5000);
    expect(result.level).toBe('NONE');
  });

  it('override with expiresAt=0 never expires', () => {
    const override: ThrottleOverride = {
      action: 'BYPASS',
      expiresAt: 0,
      reason: 'permanent bypass',
      approvedBy: 'admin@example.com',
    };
    const result = applyOverride(baseState, override, 999_999_999);
    expect(result.level).toBe('NONE');
  });

  it('FORCE_LEVEL without forceLevel keeps original state', () => {
    const override: ThrottleOverride = {
      action: 'FORCE_LEVEL',
      expiresAt: 0,
      reason: 'missing level',
      approvedBy: 'admin@example.com',
    };
    const result = applyOverride(baseState, override, 1000);
    expect(result.level).toBe(baseState.level);
  });
});

// =============================================================================
// Immutability
// =============================================================================

describe('throttle-policy/immutability', () => {
  it('computeThrottle result is frozen', () => {
    const result = computeThrottle(makePrediction(), 'OK');
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.axes)).toBe(true);
    expect(Object.isFrozen(result.axes.ratio)).toBe(true);
    expect(Object.isFrozen(result.axes.time)).toBe(true);
    expect(Object.isFrozen(result.axes.severityFloor)).toBe(true);
    expect(Object.isFrozen(result.ui)).toBe(true);
  });

  it('applyOverride result is frozen (including override object)', () => {
    const base = computeThrottle(makePrediction({ currentRatio: 0.96 }), 'OK');
    const override: ThrottleOverride = {
      action: 'BYPASS',
      expiresAt: 0,
      reason: 'test',
      approvedBy: 'test',
    };
    const result = applyOverride(base, override, 1000);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.axes)).toBe(true);
    expect(Object.isFrozen(result.ui)).toBe(true);
    expect(result.override).not.toBeNull();
    expect(Object.isFrozen(result.override)).toBe(true);
  });

  it('DEFAULT_THROTTLE_CONFIG is frozen', () => {
    expect(Object.isFrozen(DEFAULT_THROTTLE_CONFIG)).toBe(true);
    expect(Object.isFrozen(DEFAULT_THROTTLE_CONFIG.ratioThresholds)).toBe(true);
    expect(Object.isFrozen(DEFAULT_THROTTLE_CONFIG.timeThresholds)).toBe(true);
    expect(Object.isFrozen(DEFAULT_THROTTLE_CONFIG.severityFloor)).toBe(true);
  });
});

// =============================================================================
// Two-axis interaction
// =============================================================================

describe('throttle-policy/two-axis interaction', () => {
  const MS_HOUR = 3_600_000;

  it('takes strictest of both axes', () => {
    // Ratio → LIGHT (0.91), Time → HEAVY (5h)
    const result = computeThrottle(
      makePrediction({ currentRatio: 0.91, timeToExhaustMs: 5 * MS_HOUR, confidence: 0.8 }),
      'OK',
    );
    expect(result.level).toBe('HEAVY');
    expect(result.axes.selectedBy).toBe('time');
  });

  it('ratio STOPPED overrides time LIGHT', () => {
    const result = computeThrottle(
      makePrediction({ currentRatio: 0.99, timeToExhaustMs: 20 * MS_HOUR, confidence: 0.8 }),
      'OK',
    );
    expect(result.level).toBe('STOPPED');
    expect(result.axes.selectedBy).toBe('ratio');
  });

  it('time STOPPED overrides ratio LIGHT', () => {
    const result = computeThrottle(
      makePrediction({ currentRatio: 0.91, timeToExhaustMs: 30 * 60_000, confidence: 0.8 }),
      'OK',
    );
    expect(result.level).toBe('STOPPED');
    expect(result.axes.selectedBy).toBe('time');
  });

  it('severity floor elevates when both axes are NONE', () => {
    const result = computeThrottle(
      makePrediction({ currentRatio: 0.5, timeToExhaustMs: -1 }),
      'CRITICAL',
    );
    expect(result.level).toBe('HEAVY');
    expect(result.axes.selectedBy).toBe('severity_floor');
  });
});
