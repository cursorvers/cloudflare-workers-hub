export type BudgetSeverity = 'OK' | 'WARNING' | 'CRITICAL';
export type BudgetAction = 'none' | 'warn' | 'stop';

export interface BudgetThresholds {
  readonly warningRatio: number;
  readonly criticalRatio: number;
}

export interface BudgetCheckResult {
  readonly severity: BudgetSeverity;
  readonly action: BudgetAction;
  readonly usageRatio: number;
  readonly spent: number;
  readonly limit: number;
  readonly reason: string;
}

export const DEFAULT_THRESHOLDS: BudgetThresholds = Object.freeze({
  warningRatio: 0.95,
  criticalRatio: 0.98,
});

function freezeResult(result: BudgetCheckResult): BudgetCheckResult {
  return Object.freeze({ ...result });
}

function isValidMetric(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function isValidLimit(limit: number): boolean {
  return Number.isFinite(limit) && limit > 0;
}

export function validateThresholds(thresholds: BudgetThresholds): boolean {
  return (
    Number.isFinite(thresholds.warningRatio) &&
    Number.isFinite(thresholds.criticalRatio) &&
    thresholds.warningRatio >= 0 &&
    thresholds.criticalRatio >= 0 &&
    thresholds.warningRatio < thresholds.criticalRatio &&
    thresholds.criticalRatio <= 1
  );
}

// Pure budget threshold check. Fail-closed on invalid inputs.
export function checkBudget(
  spent: number,
  limit: number,
  thresholds: BudgetThresholds = DEFAULT_THRESHOLDS,
): BudgetCheckResult {
  if (!isValidMetric(spent)) {
    return freezeResult({
      severity: 'CRITICAL',
      action: 'stop',
      usageRatio: Number.NaN,
      spent,
      limit,
      reason: 'fail-closed: invalid spent',
    });
  }

  if (!isValidLimit(limit)) {
    return freezeResult({
      severity: 'CRITICAL',
      action: 'stop',
      usageRatio: Number.NaN,
      spent,
      limit,
      reason: 'fail-closed: invalid limit',
    });
  }

  if (!validateThresholds(thresholds)) {
    return freezeResult({
      severity: 'CRITICAL',
      action: 'stop',
      usageRatio: spent / limit,
      spent,
      limit,
      reason: 'fail-closed: invalid thresholds',
    });
  }

  const usageRatio = spent / limit;

  if (!Number.isFinite(usageRatio) || usageRatio < 0) {
    return freezeResult({
      severity: 'CRITICAL',
      action: 'stop',
      usageRatio,
      spent,
      limit,
      reason: 'fail-closed: invalid usage ratio',
    });
  }

  if (usageRatio >= thresholds.criticalRatio) {
    return freezeResult({
      severity: 'CRITICAL',
      action: 'stop',
      usageRatio,
      spent,
      limit,
      reason: `usage ratio ${usageRatio.toFixed(4)} >= critical threshold ${thresholds.criticalRatio.toFixed(4)}`,
    });
  }

  if (usageRatio >= thresholds.warningRatio) {
    return freezeResult({
      severity: 'WARNING',
      action: 'warn',
      usageRatio,
      spent,
      limit,
      reason: `usage ratio ${usageRatio.toFixed(4)} >= warning threshold ${thresholds.warningRatio.toFixed(4)}`,
    });
  }

  return freezeResult({
    severity: 'OK',
    action: 'none',
    usageRatio,
    spent,
    limit,
    reason: 'within budget threshold',
  });
}
