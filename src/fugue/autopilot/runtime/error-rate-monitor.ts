export type ErrorRateSeverity = 'OK' | 'INSUFFICIENT_DATA' | 'CRITICAL';
export type ErrorRateAction = 'none' | 'skip' | 'stop';

export interface ErrorRateConfig {
  readonly errorThreshold: number; // default 0.10
  readonly minSamples: number; // default 10
}

export interface ErrorRateResult {
  readonly severity: ErrorRateSeverity;
  readonly action: ErrorRateAction;
  readonly errorRate: number;
  readonly errors: number;
  readonly total: number;
  readonly reason: string;
}

export const DEFAULT_ERROR_RATE_CONFIG: ErrorRateConfig = Object.freeze({
  errorThreshold: 0.10,
  minSamples: 10,
});

function freezeResult(result: ErrorRateResult): ErrorRateResult {
  return Object.freeze({ ...result });
}

function isValidCount(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

export function validateErrorRateConfig(config: ErrorRateConfig): boolean {
  return (
    Number.isFinite(config.errorThreshold) &&
    Number.isFinite(config.minSamples) &&
    config.errorThreshold >= 0 &&
    config.errorThreshold <= 1 &&
    Number.isInteger(config.minSamples) &&
    config.minSamples >= 0
  );
}

// Pure error-rate check. Fail-closed on invalid inputs/configuration.
export function checkErrorRate(
  errors: number,
  total: number,
  config: ErrorRateConfig = DEFAULT_ERROR_RATE_CONFIG,
): ErrorRateResult {
  if (!isValidCount(errors)) {
    return freezeResult({
      severity: 'CRITICAL',
      action: 'stop',
      errorRate: Number.NaN,
      errors,
      total,
      reason: 'fail-closed: invalid errors',
    });
  }

  if (!isValidCount(total)) {
    return freezeResult({
      severity: 'CRITICAL',
      action: 'stop',
      errorRate: Number.NaN,
      errors,
      total,
      reason: 'fail-closed: invalid total',
    });
  }

  if (!validateErrorRateConfig(config)) {
    return freezeResult({
      severity: 'CRITICAL',
      action: 'stop',
      errorRate: total > 0 ? errors / total : Number.NaN,
      errors,
      total,
      reason: 'fail-closed: invalid config',
    });
  }

  if (errors > total) {
    return freezeResult({
      severity: 'CRITICAL',
      action: 'stop',
      errorRate: total > 0 ? errors / total : Number.NaN,
      errors,
      total,
      reason: 'fail-closed: errors exceed total',
    });
  }

  if (total < config.minSamples) {
    return freezeResult({
      severity: 'INSUFFICIENT_DATA',
      action: 'skip',
      errorRate: total > 0 ? errors / total : 0,
      errors,
      total,
      reason: `insufficient samples: total ${total} < minSamples ${config.minSamples}`,
    });
  }

  const errorRate = errors / total;

  if (!Number.isFinite(errorRate) || errorRate < 0) {
    return freezeResult({
      severity: 'CRITICAL',
      action: 'stop',
      errorRate,
      errors,
      total,
      reason: 'fail-closed: invalid error rate',
    });
  }

  if (errorRate >= config.errorThreshold) {
    return freezeResult({
      severity: 'CRITICAL',
      action: 'stop',
      errorRate,
      errors,
      total,
      reason: `error rate ${errorRate.toFixed(4)} >= threshold ${config.errorThreshold.toFixed(4)}`,
    });
  }

  return freezeResult({
    severity: 'OK',
    action: 'none',
    errorRate,
    errors,
    total,
    reason: 'within error threshold',
  });
}
