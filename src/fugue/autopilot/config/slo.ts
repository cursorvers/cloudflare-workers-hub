export interface SloMetrics {
  readonly maxRecursionDepth: number;
  readonly recoveryRate: number;
  readonly guardrailViolations: number;
  readonly p99LatencyMs: number;
  readonly totalDecisions: number;
  readonly deniedDecisions: number;
}

export interface SloThresholds {
  readonly maxRecursionDepth: number;
  readonly minRecoveryRate: number;
  readonly maxGuardrailViolations: number;
  readonly maxP99LatencyMs: number;
}

export interface SloComplianceResult {
  readonly compliant: boolean;
  readonly violations: readonly string[];
}

export const DEFAULT_SLO_THRESHOLDS: SloThresholds = Object.freeze({
  maxRecursionDepth: 6,
  minRecoveryRate: 0.995,
  maxGuardrailViolations: 0,
  maxP99LatencyMs: 5000,
});

export function createSloMetrics(): SloMetrics {
  return Object.freeze({
    maxRecursionDepth: 0,
    recoveryRate: 0,
    guardrailViolations: 0,
    p99LatencyMs: 0,
    totalDecisions: 0,
    deniedDecisions: 0,
  });
}

export function checkSloCompliance(
  metrics: SloMetrics,
  thresholds: SloThresholds = DEFAULT_SLO_THRESHOLDS,
): SloComplianceResult {
  const violations: string[] = [];
  if (metrics.maxRecursionDepth > thresholds.maxRecursionDepth) {
    violations.push(`maxRecursionDepth>${thresholds.maxRecursionDepth}`);
  }
  if (metrics.recoveryRate < thresholds.minRecoveryRate) {
    violations.push(`recoveryRate<${thresholds.minRecoveryRate}`);
  }
  if (metrics.guardrailViolations > thresholds.maxGuardrailViolations) {
    violations.push(`guardrailViolations>${thresholds.maxGuardrailViolations}`);
  }
  if (metrics.p99LatencyMs > thresholds.maxP99LatencyMs) {
    violations.push(`p99LatencyMs>${thresholds.maxP99LatencyMs}`);
  }
  return Object.freeze({ compliant: violations.length === 0, violations: Object.freeze([...violations]) });
}
