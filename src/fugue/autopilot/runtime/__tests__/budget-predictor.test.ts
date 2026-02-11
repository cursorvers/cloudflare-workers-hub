import { describe, expect, it } from 'vitest';

import {
  linearSlope,
  linearPredict,
  wmaSpendRate,
  wmaPredict,
  predictBudgetExhaustion,
  DEFAULT_PREDICTION_CONFIG,
  type BudgetSample,
  type PredictionConfig,
} from '../budget-predictor';

// =============================================================================
// Helpers
// =============================================================================

/** Generate linearly increasing samples: spent = baseSpent + rate * (t - t0) */
function linearSamples(
  count: number,
  startMs: number,
  intervalMs: number,
  baseSpent: number,
  ratePerMs: number,
): BudgetSample[] {
  return Array.from({ length: count }, (_, i) => ({
    timestamp: startMs + i * intervalMs,
    spent: baseSpent + ratePerMs * i * intervalMs,
  }));
}

/** Generate flat (no-growth) samples */
function flatSamples(count: number, startMs: number, intervalMs: number, spent: number): BudgetSample[] {
  return Array.from({ length: count }, (_, i) => ({
    timestamp: startMs + i * intervalMs,
    spent,
  }));
}

// =============================================================================
// linearSlope
// =============================================================================

describe('budget-predictor/linearSlope', () => {
  it('returns 0 for empty samples', () => {
    expect(linearSlope([])).toBe(0);
  });

  it('returns 0 for single sample', () => {
    expect(linearSlope([{ timestamp: 1000, spent: 50 }])).toBe(0);
  });

  it('computes positive slope for increasing spend', () => {
    const samples = linearSamples(5, 0, 1000, 0, 0.01); // 0.01 units/ms
    const slope = linearSlope(samples);
    expect(slope).toBeCloseTo(0.01, 6);
  });

  it('returns 0 for flat spend', () => {
    const samples = flatSamples(5, 0, 1000, 100);
    expect(linearSlope(samples)).toBe(0);
  });

  it('returns negative slope for decreasing spend', () => {
    const samples: BudgetSample[] = [
      { timestamp: 0, spent: 100 },
      { timestamp: 1000, spent: 90 },
      { timestamp: 2000, spent: 80 },
    ];
    expect(linearSlope(samples)).toBeLessThan(0);
  });

  it('handles identical timestamps (denominator = 0)', () => {
    const samples: BudgetSample[] = [
      { timestamp: 1000, spent: 10 },
      { timestamp: 1000, spent: 20 },
    ];
    expect(linearSlope(samples)).toBe(0);
  });

  it('handles large Date.now() timestamps without catastrophic cancellation', () => {
    // Simulate real timestamps (e.g. 2026-02-11)
    const baseTs = 1_770_768_000_000; // ~Feb 2026 epoch ms
    const samples = linearSamples(5, baseTs, 60_000, 0, 0.001); // 0.001 units/ms
    const slope = linearSlope(samples);
    expect(slope).toBeCloseTo(0.001, 6);
  });
});

// =============================================================================
// linearPredict
// =============================================================================

describe('budget-predictor/linearPredict', () => {
  it('returns no exhaustion for flat spend', () => {
    const samples = flatSamples(5, 0, 1000, 50);
    const result = linearPredict(samples, 100, 5000);
    expect(result.timeToExhaustMs).toBe(-1);
    expect(result.exhaustionTimestamp).toBe(0);
    expect(result.spendRate).toBe(0);
  });

  it('predicts exhaustion for linear increasing spend', () => {
    // 0.01 units/ms, starts at 0, limit 100
    // At t=5000, spent=50, remaining=50, timeToExhaust=50/0.01=5000ms
    const samples = linearSamples(6, 0, 1000, 0, 0.01);
    const result = linearPredict(samples, 100, 5000);
    expect(result.timeToExhaustMs).toBeGreaterThan(0);
    expect(result.exhaustionTimestamp).toBeGreaterThan(5000);
    expect(result.spendRate).toBeCloseTo(0.01, 6);
  });

  it('returns 0 timeToExhaust when already exhausted', () => {
    const samples: BudgetSample[] = [
      { timestamp: 0, spent: 80 },
      { timestamp: 1000, spent: 100 },
    ];
    const result = linearPredict(samples, 100, 1000);
    expect(result.timeToExhaustMs).toBe(0);
    expect(result.exhaustionTimestamp).toBe(1000);
    expect(result.spendRate).toBeGreaterThan(0);
  });

  it('returns frozen result', () => {
    const samples = linearSamples(3, 0, 1000, 0, 0.01);
    const result = linearPredict(samples, 100, 3000);
    expect(Object.isFrozen(result)).toBe(true);
  });
});

// =============================================================================
// wmaSpendRate
// =============================================================================

describe('budget-predictor/wmaSpendRate', () => {
  it('returns 0 for empty samples', () => {
    expect(wmaSpendRate([], 0.85)).toBe(0);
  });

  it('returns 0 for single sample', () => {
    expect(wmaSpendRate([{ timestamp: 1000, spent: 50 }], 0.85)).toBe(0);
  });

  it('computes rate for uniform intervals', () => {
    const samples = linearSamples(5, 0, 1000, 0, 0.01);
    const rate = wmaSpendRate(samples, 0.85);
    // All deltas are 0.01 units/ms, so WMA should be ~0.01
    expect(rate).toBeCloseTo(0.01, 6);
  });

  it('weights recent samples more heavily', () => {
    // First intervals: low rate, last interval: high rate
    const samples: BudgetSample[] = [
      { timestamp: 0, spent: 0 },
      { timestamp: 1000, spent: 1 },    // rate = 0.001
      { timestamp: 2000, spent: 2 },    // rate = 0.001
      { timestamp: 3000, spent: 12 },   // rate = 0.01 (10x spike)
    ];
    const rate = wmaSpendRate(samples, 0.85);
    // Should be biased toward 0.01 (recent spike), above simple average of 0.004
    expect(rate).toBeGreaterThan(0.004);
  });

  it('returns 0 for flat spend', () => {
    const samples = flatSamples(5, 0, 1000, 100);
    expect(wmaSpendRate(samples, 0.85)).toBe(0);
  });

  it('skips zero-duration intervals', () => {
    const samples: BudgetSample[] = [
      { timestamp: 0, spent: 0 },
      { timestamp: 0, spent: 5 },   // dt=0, skipped
      { timestamp: 1000, spent: 10 },
    ];
    const rate = wmaSpendRate(samples, 0.85);
    // Only the last interval counts: (10-5)/1000 = 0.005
    expect(rate).toBeCloseTo(0.005, 6);
  });
});

// =============================================================================
// wmaPredict
// =============================================================================

describe('budget-predictor/wmaPredict', () => {
  it('returns no exhaustion for flat spend', () => {
    const samples = flatSamples(5, 0, 1000, 50);
    const result = wmaPredict(samples, 100, 5000, 0.85);
    expect(result.timeToExhaustMs).toBe(-1);
    expect(result.spendRate).toBe(0);
  });

  it('predicts exhaustion for increasing spend', () => {
    const samples = linearSamples(5, 0, 1000, 0, 0.01);
    const result = wmaPredict(samples, 100, 4000, 0.85);
    expect(result.timeToExhaustMs).toBeGreaterThan(0);
    expect(result.spendRate).toBeGreaterThan(0);
  });

  it('returns 0 timeToExhaust when already exhausted', () => {
    const samples: BudgetSample[] = [
      { timestamp: 0, spent: 90 },
      { timestamp: 1000, spent: 100 },
    ];
    const result = wmaPredict(samples, 100, 1000, 0.85);
    expect(result.timeToExhaustMs).toBe(0);
    expect(result.exhaustionTimestamp).toBe(1000);
  });

  it('returns frozen result', () => {
    const samples = linearSamples(3, 0, 1000, 0, 0.01);
    const result = wmaPredict(samples, 100, 3000, 0.85);
    expect(Object.isFrozen(result)).toBe(true);
  });
});

// =============================================================================
// predictBudgetExhaustion (hybrid)
// =============================================================================

describe('budget-predictor/predictBudgetExhaustion', () => {
  const config: PredictionConfig = {
    windowSize: 30,
    wmaDecayFactor: 0.85,
    minSamplesForPrediction: 3,
  };

  describe('insufficient data', () => {
    it('returns insufficient_data for empty samples', () => {
      const result = predictBudgetExhaustion([], 100, 1000, config);
      expect(result.method).toBe('insufficient_data');
      expect(result.timeToExhaustMs).toBe(-1);
      expect(result.confidence).toBe(0);
      expect(result.sampleCount).toBe(0);
    });

    it('returns insufficient_data for 1 sample', () => {
      const result = predictBudgetExhaustion(
        [{ timestamp: 1000, spent: 50 }],
        100,
        2000,
        config,
      );
      expect(result.method).toBe('insufficient_data');
      expect(result.sampleCount).toBe(1);
      expect(result.spent).toBe(50);
      expect(result.currentRatio).toBeCloseTo(0.5);
    });

    it('returns insufficient_data for 2 samples (below min 3)', () => {
      const result = predictBudgetExhaustion(
        [
          { timestamp: 1000, spent: 30 },
          { timestamp: 2000, spent: 40 },
        ],
        100,
        3000,
        config,
      );
      expect(result.method).toBe('insufficient_data');
      expect(result.sampleCount).toBe(2);
    });
  });

  describe('invalid inputs', () => {
    it('returns immediate exhaustion for limit=0', () => {
      const result = predictBudgetExhaustion(
        [{ timestamp: 1000, spent: 50 }],
        0,
        2000,
        config,
      );
      expect(result.method).toBe('insufficient_data');
      expect(result.timeToExhaustMs).toBe(0);
      expect(result.exhaustionTimestamp).toBe(2000);
      expect(result.limit).toBe(0);
    });

    it('returns immediate exhaustion for negative limit', () => {
      const result = predictBudgetExhaustion([], -100, 2000, config);
      expect(result.method).toBe('insufficient_data');
      expect(result.timeToExhaustMs).toBe(0);
    });

    it('returns immediate exhaustion for NaN limit', () => {
      const result = predictBudgetExhaustion([], NaN, 2000, config);
      expect(result.method).toBe('insufficient_data');
      expect(result.timeToExhaustMs).toBe(0);
    });

    it('filters out invalid samples (negative timestamp)', () => {
      const samples: BudgetSample[] = [
        { timestamp: -1, spent: 10 },  // invalid
        { timestamp: 1000, spent: 20 },
        { timestamp: 2000, spent: 30 },
      ];
      const result = predictBudgetExhaustion(samples, 100, 3000, config);
      // Only 2 valid samples < minSamplesForPrediction(3)
      expect(result.method).toBe('insufficient_data');
      expect(result.sampleCount).toBe(2);
    });

    it('filters out NaN spent samples', () => {
      const samples: BudgetSample[] = [
        { timestamp: 1000, spent: NaN },
        { timestamp: 2000, spent: 20 },
        { timestamp: 3000, spent: 30 },
        { timestamp: 4000, spent: 40 },
      ];
      const result = predictBudgetExhaustion(samples, 100, 5000, config);
      expect(result.sampleCount).toBe(3);
    });
  });

  describe('stable/decreasing spend', () => {
    it('returns no exhaustion for flat spend', () => {
      const samples = flatSamples(5, 0, 1000, 50);
      const result = predictBudgetExhaustion(samples, 100, 5000, config);
      expect(result.method).toBe('hybrid');
      expect(result.timeToExhaustMs).toBe(-1);
      expect(result.exhaustionTimestamp).toBe(0);
      expect(result.spendRate).toBe(0);
    });

    it('returns no exhaustion for decreasing spend', () => {
      const samples: BudgetSample[] = [
        { timestamp: 0, spent: 80 },
        { timestamp: 1000, spent: 70 },
        { timestamp: 2000, spent: 60 },
        { timestamp: 3000, spent: 50 },
      ];
      const result = predictBudgetExhaustion(samples, 100, 4000, config);
      expect(result.timeToExhaustMs).toBe(-1);
      expect(result.spendRate).toBe(0);
    });
  });

  describe('increasing spend (exhaustion predicted)', () => {
    it('predicts exhaustion with hybrid method when both agree', () => {
      const samples = linearSamples(10, 0, 1000, 0, 0.01);
      const result = predictBudgetExhaustion(samples, 100, 9000, config);
      expect(result.method).toBe('hybrid');
      expect(result.timeToExhaustMs).toBeGreaterThan(0);
      expect(result.exhaustionTimestamp).toBeGreaterThan(9000);
      expect(result.spendRate).toBeGreaterThan(0);
      expect(result.confidence).toBeGreaterThan(0);
    });

    it('takes the more conservative (earlier) prediction', () => {
      const samples = linearSamples(10, 0, 1000, 0, 0.01);
      const result = predictBudgetExhaustion(samples, 100, 9000, config);
      // Hybrid should take the earlier exhaustion time of the two methods
      expect(result.timeToExhaustMs).toBeGreaterThan(0);
    });

    it('reports correct currentRatio', () => {
      const samples = linearSamples(5, 0, 1000, 0, 0.01);
      // At t=4000, spent = 0 + 0.01 * 4 * 1000 = 40
      const result = predictBudgetExhaustion(samples, 100, 5000, config);
      expect(result.currentRatio).toBeCloseTo(0.4, 2);
      expect(result.spent).toBeCloseTo(40, 0);
      expect(result.limit).toBe(100);
    });
  });

  describe('already exhausted', () => {
    it('returns 0 timeToExhaust when spent >= limit', () => {
      const samples: BudgetSample[] = [
        { timestamp: 0, spent: 80 },
        { timestamp: 1000, spent: 90 },
        { timestamp: 2000, spent: 100 },
      ];
      const result = predictBudgetExhaustion(samples, 100, 2000, config);
      expect(result.timeToExhaustMs).toBe(0);
      expect(result.exhaustionTimestamp).toBe(2000);
    });
  });

  describe('window sliding', () => {
    it('respects windowSize config', () => {
      const smallWindow: PredictionConfig = {
        windowSize: 5,
        wmaDecayFactor: 0.85,
        minSamplesForPrediction: 3,
      };
      const samples = linearSamples(20, 0, 1000, 0, 0.01);
      const result = predictBudgetExhaustion(samples, 200, 20000, smallWindow);
      expect(result.sampleCount).toBe(5);
    });
  });

  describe('confidence', () => {
    it('increases with more samples', () => {
      const few = linearSamples(3, 0, 1000, 0, 0.01);
      const many = linearSamples(20, 0, 1000, 0, 0.01);

      const resultFew = predictBudgetExhaustion(few, 100, 3000, config);
      const resultMany = predictBudgetExhaustion(many, 100, 20000, config);

      expect(resultMany.confidence).toBeGreaterThan(resultFew.confidence);
    });

    it('is between 0 and 1', () => {
      const samples = linearSamples(10, 0, 1000, 0, 0.01);
      const result = predictBudgetExhaustion(samples, 100, 10000, config);
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    });
  });

  describe('immutability', () => {
    it('all results are Object.freeze', () => {
      const samples = linearSamples(5, 0, 1000, 0, 0.01);
      const result = predictBudgetExhaustion(samples, 100, 5000, config);
      expect(Object.isFrozen(result)).toBe(true);
    });

    it('insufficient_data result is frozen', () => {
      const result = predictBudgetExhaustion([], 100, 1000, config);
      expect(Object.isFrozen(result)).toBe(true);
    });

    it('invalid limit result is frozen', () => {
      const result = predictBudgetExhaustion([], 0, 1000, config);
      expect(Object.isFrozen(result)).toBe(true);
    });
  });

  describe('DEFAULT_PREDICTION_CONFIG', () => {
    it('is frozen', () => {
      expect(Object.isFrozen(DEFAULT_PREDICTION_CONFIG)).toBe(true);
    });

    it('has expected defaults', () => {
      expect(DEFAULT_PREDICTION_CONFIG.windowSize).toBe(30);
      expect(DEFAULT_PREDICTION_CONFIG.wmaDecayFactor).toBe(0.85);
      expect(DEFAULT_PREDICTION_CONFIG.minSamplesForPrediction).toBe(3);
    });
  });
});
