/**
 * Budget Predictor — Statistical forecasting for budget exhaustion.
 *
 * Uses linear regression + weighted moving average (WMA) hybrid approach.
 * Takes the more conservative (earlier) exhaustion prediction.
 *
 * All functions are pure and return frozen objects.
 * Statistical only — no ML.
 */

// =============================================================================
// Types
// =============================================================================

export interface BudgetSample {
  readonly timestamp: number;
  readonly spent: number;
}

export interface PredictionConfig {
  readonly windowSize: number;         // max samples in sliding window
  readonly wmaDecayFactor: number;     // weight decay for WMA (0-1, higher = more recent bias)
  readonly minSamplesForPrediction: number;  // min samples needed for prediction
}

export interface BudgetPrediction {
  readonly method: 'linear' | 'wma' | 'hybrid' | 'insufficient_data';
  readonly timeToExhaustMs: number;    // ms until budget exhaustion (-1 = not exhausting)
  readonly exhaustionTimestamp: number; // predicted exhaustion time (0 = not exhausting)
  readonly spendRate: number;           // units per ms (0 = stable/decreasing)
  readonly confidence: number;          // 0.0 - 1.0
  readonly currentRatio: number;        // current spent/limit
  readonly limit: number;
  readonly spent: number;
  readonly sampleCount: number;
}

// =============================================================================
// Constants
// =============================================================================

export const DEFAULT_PREDICTION_CONFIG: PredictionConfig = Object.freeze({
  windowSize: 30,
  wmaDecayFactor: 0.85,
  minSamplesForPrediction: 3,
});

const NO_EXHAUSTION_MS = -1;
const NO_EXHAUSTION_TS = 0;

// =============================================================================
// Helpers
// =============================================================================

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function isValidSample(s: BudgetSample): boolean {
  return (
    Number.isFinite(s.timestamp) &&
    Number.isFinite(s.spent) &&
    s.timestamp >= 0 &&
    s.spent >= 0
  );
}

// =============================================================================
// Linear Regression
// =============================================================================

/**
 * Compute slope (spend rate) via ordinary least squares.
 * Returns units/ms. Negative or zero means budget is stable/decreasing.
 *
 * Timestamps are normalized (offset by first sample) to prevent
 * catastrophic cancellation with large Date.now() values.
 */
export function linearSlope(samples: readonly BudgetSample[]): number {
  const n = samples.length;
  if (n < 2) return 0;

  // Normalize: shift timestamps so first sample is at x=0
  const t0 = samples[0].timestamp;

  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumX2 = 0;

  for (const s of samples) {
    const x = s.timestamp - t0;
    sumX += x;
    sumY += s.spent;
    sumXY += x * s.spent;
    sumX2 += x * x;
  }

  const denominator = n * sumX2 - sumX * sumX;
  if (denominator === 0) return 0;

  const slope = (n * sumXY - sumX * sumY) / denominator;
  return Number.isFinite(slope) ? slope : 0;
}

/**
 * Predict time to exhaustion using linear regression.
 * Returns ms from now, or NO_EXHAUSTION_MS if not exhausting.
 */
export function linearPredict(
  samples: readonly BudgetSample[],
  limit: number,
  nowMs: number,
): { timeToExhaustMs: number; exhaustionTimestamp: number; spendRate: number } {
  const slope = linearSlope(samples);

  if (slope <= 0) {
    return Object.freeze({
      timeToExhaustMs: NO_EXHAUSTION_MS,
      exhaustionTimestamp: NO_EXHAUSTION_TS,
      spendRate: 0,
    });
  }

  const lastSample = samples[samples.length - 1];
  const remaining = limit - lastSample.spent;

  if (remaining <= 0) {
    return Object.freeze({
      timeToExhaustMs: 0,
      exhaustionTimestamp: nowMs,
      spendRate: slope,
    });
  }

  const timeToExhaust = remaining / slope;
  const elapsed = nowMs - lastSample.timestamp;
  const adjustedTime = Math.max(0, timeToExhaust - elapsed);

  return Object.freeze({
    timeToExhaustMs: Number.isFinite(adjustedTime) ? adjustedTime : NO_EXHAUSTION_MS,
    exhaustionTimestamp: Number.isFinite(adjustedTime) ? nowMs + adjustedTime : NO_EXHAUSTION_TS,
    spendRate: slope,
  });
}

// =============================================================================
// Weighted Moving Average
// =============================================================================

/**
 * Compute spend rate using weighted moving average of consecutive deltas.
 * More recent deltas have higher weight (decay factor).
 */
export function wmaSpendRate(
  samples: readonly BudgetSample[],
  decayFactor: number,
): number {
  const n = samples.length;
  if (n < 2) return 0;

  let weightedSum = 0;
  let totalWeight = 0;

  for (let i = 1; i < n; i++) {
    const dt = samples[i].timestamp - samples[i - 1].timestamp;
    if (dt <= 0) continue;

    const rate = (samples[i].spent - samples[i - 1].spent) / dt;
    const weight = Math.pow(decayFactor, n - 1 - i);

    weightedSum += rate * weight;
    totalWeight += weight;
  }

  if (totalWeight === 0) return 0;
  const result = weightedSum / totalWeight;
  return Number.isFinite(result) ? result : 0;
}

/**
 * Predict time to exhaustion using weighted moving average.
 */
export function wmaPredict(
  samples: readonly BudgetSample[],
  limit: number,
  nowMs: number,
  decayFactor: number,
): { timeToExhaustMs: number; exhaustionTimestamp: number; spendRate: number } {
  const rate = wmaSpendRate(samples, decayFactor);

  if (rate <= 0) {
    return Object.freeze({
      timeToExhaustMs: NO_EXHAUSTION_MS,
      exhaustionTimestamp: NO_EXHAUSTION_TS,
      spendRate: 0,
    });
  }

  const lastSample = samples[samples.length - 1];
  const remaining = limit - lastSample.spent;

  if (remaining <= 0) {
    return Object.freeze({
      timeToExhaustMs: 0,
      exhaustionTimestamp: nowMs,
      spendRate: rate,
    });
  }

  const timeToExhaust = remaining / rate;
  const elapsed = nowMs - lastSample.timestamp;
  const adjustedTime = Math.max(0, timeToExhaust - elapsed);

  return Object.freeze({
    timeToExhaustMs: Number.isFinite(adjustedTime) ? adjustedTime : NO_EXHAUSTION_MS,
    exhaustionTimestamp: Number.isFinite(adjustedTime) ? nowMs + adjustedTime : NO_EXHAUSTION_TS,
    spendRate: rate,
  });
}

// =============================================================================
// Hybrid Prediction (Main Entry Point)
// =============================================================================

/**
 * Predict budget exhaustion using hybrid linear + WMA approach.
 * Takes the more conservative (earlier) exhaustion prediction.
 * Falls back to current ratio check when insufficient data.
 */
export function predictBudgetExhaustion(
  samples: readonly BudgetSample[],
  limit: number,
  nowMs?: number,
  config: PredictionConfig = DEFAULT_PREDICTION_CONFIG,
): BudgetPrediction {
  const now = typeof nowMs === 'number' && Number.isFinite(nowMs) ? nowMs : Date.now();

  // Validate inputs
  if (!Number.isFinite(limit) || limit <= 0) {
    return Object.freeze({
      method: 'insufficient_data' as const,
      timeToExhaustMs: 0,
      exhaustionTimestamp: now,
      spendRate: 0,
      confidence: 0,
      currentRatio: 1,
      limit: 0,
      spent: 0,
      sampleCount: 0,
    });
  }

  // Filter valid samples, sort only if needed, then take window tail
  const filtered = samples.filter(isValidSample);
  const alreadySorted = filtered.every(
    (s, i) => i === 0 || s.timestamp >= filtered[i - 1].timestamp,
  );
  const sorted = alreadySorted ? filtered : [...filtered].sort((a, b) => a.timestamp - b.timestamp);
  const validSamples = sorted.slice(-config.windowSize);

  const sampleCount = validSamples.length;
  const latestSpent = sampleCount > 0 ? validSamples[sampleCount - 1].spent : 0;
  const currentRatio = latestSpent / limit;

  // Insufficient data: fall back to ratio-only
  if (sampleCount < config.minSamplesForPrediction) {
    return Object.freeze({
      method: 'insufficient_data' as const,
      timeToExhaustMs: NO_EXHAUSTION_MS,
      exhaustionTimestamp: NO_EXHAUSTION_TS,
      spendRate: 0,
      confidence: 0,
      currentRatio,
      limit,
      spent: latestSpent,
      sampleCount,
    });
  }

  // Compute both predictions
  const lin = linearPredict(validSamples, limit, now);
  const wma = wmaPredict(validSamples, limit, now, config.wmaDecayFactor);

  // Take the more conservative (earlier) exhaustion time
  let timeToExhaustMs: number;
  let exhaustionTimestamp: number;
  let spendRate: number;
  let method: 'linear' | 'wma' | 'hybrid';

  const linExhausting = lin.timeToExhaustMs >= 0;
  const wmaExhausting = wma.timeToExhaustMs >= 0;

  if (linExhausting && wmaExhausting) {
    // Both predict exhaustion: take the earlier one
    if (lin.timeToExhaustMs <= wma.timeToExhaustMs) {
      timeToExhaustMs = lin.timeToExhaustMs;
      exhaustionTimestamp = lin.exhaustionTimestamp;
      spendRate = lin.spendRate;
    } else {
      timeToExhaustMs = wma.timeToExhaustMs;
      exhaustionTimestamp = wma.exhaustionTimestamp;
      spendRate = wma.spendRate;
    }
    method = 'hybrid';
  } else if (linExhausting) {
    timeToExhaustMs = lin.timeToExhaustMs;
    exhaustionTimestamp = lin.exhaustionTimestamp;
    spendRate = lin.spendRate;
    method = 'linear';
  } else if (wmaExhausting) {
    timeToExhaustMs = wma.timeToExhaustMs;
    exhaustionTimestamp = wma.exhaustionTimestamp;
    spendRate = wma.spendRate;
    method = 'wma';
  } else {
    // Neither predicts exhaustion
    return Object.freeze({
      method: 'hybrid' as const,
      timeToExhaustMs: NO_EXHAUSTION_MS,
      exhaustionTimestamp: NO_EXHAUSTION_TS,
      spendRate: 0,
      confidence: clamp(sampleCount / config.windowSize, 0, 1),
      currentRatio,
      limit,
      spent: latestSpent,
      sampleCount,
    });
  }

  // Confidence: higher with more samples and consistent predictions
  const sampleConfidence = clamp(sampleCount / config.windowSize, 0, 1);
  const consistency = (linExhausting && wmaExhausting)
    ? 1 - Math.abs(lin.timeToExhaustMs - wma.timeToExhaustMs) /
        Math.max(lin.timeToExhaustMs, wma.timeToExhaustMs, 1)
    : 0.5;
  const confidence = clamp(sampleConfidence * 0.6 + consistency * 0.4, 0, 1);

  return Object.freeze({
    method,
    timeToExhaustMs,
    exhaustionTimestamp,
    spendRate,
    confidence,
    currentRatio,
    limit,
    spent: latestSpent,
    sampleCount,
  });
}
