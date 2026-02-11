/**
 * Throttle Policy — Rate-limiting based on budget prediction + severity.
 *
 * Two-axis decision matrix:
 *   Axis 1: timeToExhaust (from budget-predictor)
 *   Axis 2: spent/limit ratio (currentRatio)
 * Severity floor: budget-guard severity guarantees minimum throttle level.
 *
 * All functions are pure and return frozen objects.
 */

import type { BudgetPrediction } from './budget-predictor';
import type { BudgetSeverity } from './budget-guard';

// =============================================================================
// Types
// =============================================================================

export type ThrottleLevel = 'NONE' | 'LIGHT' | 'HEAVY' | 'STOPPED';

export interface ThrottleConfig {
  /** Ratio thresholds for throttle levels (spent/limit) */
  readonly ratioThresholds: {
    readonly light: number;   // >= this → LIGHT (default 0.90)
    readonly heavy: number;   // >= this → HEAVY (default 0.95)
    readonly stopped: number; // >= this → STOPPED (default 0.98)
  };
  /** Time-to-exhaust thresholds in ms */
  readonly timeThresholds: {
    readonly light: number;   // <= this → LIGHT (default 24h)
    readonly heavy: number;   // <= this → HEAVY (default 6h)
    readonly stopped: number; // <= this → STOPPED (default 1h)
  };
  /** Minimum prediction confidence to use time-based axis (default 0.35) */
  readonly minConfidence: number;
  /** Fail-closed: STOPPED on invalid inputs (default true) */
  readonly failClosedOnInvalidInput: boolean;
  /** Severity floor mapping: severity → minimum throttle level */
  readonly severityFloor: {
    readonly OK: ThrottleLevel;
    readonly WARNING: ThrottleLevel;
    readonly CRITICAL: ThrottleLevel;
  };
}

export interface ThrottleAxisResult {
  readonly level: ThrottleLevel;
  readonly reason: string;
}

export interface ThrottleState {
  readonly level: ThrottleLevel;
  readonly rate: number; // 1.0 = full speed, 0.7 = light, 0.4 = heavy, 0.0 = stopped
  readonly axes: {
    readonly ratio: ThrottleAxisResult;
    readonly time: ThrottleAxisResult;
    readonly severityFloor: ThrottleAxisResult;
    readonly selectedBy: 'ratio' | 'time' | 'severity_floor' | 'override';
  };
  readonly override: ThrottleOverride | null;
  readonly ui: ThrottleUiStatus;
}

export type OverrideAction = 'BYPASS' | 'FORCE_LEVEL';

export interface ThrottleOverride {
  readonly action: OverrideAction;
  readonly forceLevel?: ThrottleLevel;
  readonly expiresAt: number; // ms timestamp, 0 = no expiry
  readonly reason: string;
  readonly approvedBy: string;
}

export interface ThrottleUiStatus {
  readonly badge: string;
  readonly headline: string;
  readonly detail: string;
  readonly tone: 'normal' | 'caution' | 'warning' | 'critical';
}

// =============================================================================
// Constants
// =============================================================================

const MS_HOUR = 3_600_000;

const RATE_MAP: Record<ThrottleLevel, number> = {
  NONE: 1.0,
  LIGHT: 0.7,
  HEAVY: 0.4,
  STOPPED: 0.0,
};

const LEVEL_PRIORITY: Record<ThrottleLevel, number> = {
  NONE: 0,
  LIGHT: 1,
  HEAVY: 2,
  STOPPED: 3,
};

const TONE_MAP: Record<ThrottleLevel, ThrottleUiStatus['tone']> = {
  NONE: 'normal',
  LIGHT: 'caution',
  HEAVY: 'warning',
  STOPPED: 'critical',
};

export const DEFAULT_THROTTLE_CONFIG: ThrottleConfig = Object.freeze({
  ratioThresholds: Object.freeze({
    light: 0.90,
    heavy: 0.95,
    stopped: 0.98,
  }),
  timeThresholds: Object.freeze({
    light: 24 * MS_HOUR,
    heavy: 6 * MS_HOUR,
    stopped: 1 * MS_HOUR,
  }),
  minConfidence: 0.35,
  failClosedOnInvalidInput: true,
  severityFloor: Object.freeze({
    OK: 'NONE' as ThrottleLevel,
    WARNING: 'LIGHT' as ThrottleLevel,
    CRITICAL: 'HEAVY' as ThrottleLevel,
  }),
});

// =============================================================================
// Helpers
// =============================================================================

function maxLevel(a: ThrottleLevel, b: ThrottleLevel): ThrottleLevel {
  return LEVEL_PRIORITY[a] >= LEVEL_PRIORITY[b] ? a : b;
}

function buildUiStatus(level: ThrottleLevel, axes: ThrottleState['axes']): ThrottleUiStatus {
  const tone = TONE_MAP[level];

  const headlines: Record<ThrottleLevel, string> = {
    NONE: 'Budget nominal',
    LIGHT: 'Budget throttle: light',
    HEAVY: 'Budget throttle: heavy',
    STOPPED: 'Budget throttle: stopped',
  };

  const detail = axes.selectedBy === 'override'
    ? 'Manual override active'
    : `Determined by ${axes.selectedBy} axis`;

  return Object.freeze({
    badge: level,
    headline: headlines[level],
    detail,
    tone,
  });
}

// =============================================================================
// Axis Evaluators
// =============================================================================

function evaluateRatioAxis(
  currentRatio: number,
  thresholds: ThrottleConfig['ratioThresholds'],
): ThrottleAxisResult {
  if (currentRatio >= thresholds.stopped) {
    return Object.freeze({
      level: 'STOPPED' as ThrottleLevel,
      reason: `ratio ${currentRatio.toFixed(4)} >= stopped ${thresholds.stopped}`,
    });
  }
  if (currentRatio >= thresholds.heavy) {
    return Object.freeze({
      level: 'HEAVY' as ThrottleLevel,
      reason: `ratio ${currentRatio.toFixed(4)} >= heavy ${thresholds.heavy}`,
    });
  }
  if (currentRatio >= thresholds.light) {
    return Object.freeze({
      level: 'LIGHT' as ThrottleLevel,
      reason: `ratio ${currentRatio.toFixed(4)} >= light ${thresholds.light}`,
    });
  }
  return Object.freeze({
    level: 'NONE' as ThrottleLevel,
    reason: `ratio ${currentRatio.toFixed(4)} within budget`,
  });
}

function evaluateTimeAxis(
  timeToExhaustMs: number,
  confidence: number,
  minConfidence: number,
  thresholds: ThrottleConfig['timeThresholds'],
): ThrottleAxisResult {
  // No exhaustion predicted or low confidence
  if (timeToExhaustMs < 0 || confidence < minConfidence) {
    return Object.freeze({
      level: 'NONE' as ThrottleLevel,
      reason: timeToExhaustMs < 0
        ? 'no exhaustion predicted'
        : `confidence ${confidence.toFixed(2)} < min ${minConfidence}`,
    });
  }

  if (timeToExhaustMs <= thresholds.stopped) {
    return Object.freeze({
      level: 'STOPPED' as ThrottleLevel,
      reason: `timeToExhaust ${timeToExhaustMs}ms <= stopped ${thresholds.stopped}ms`,
    });
  }
  if (timeToExhaustMs <= thresholds.heavy) {
    return Object.freeze({
      level: 'HEAVY' as ThrottleLevel,
      reason: `timeToExhaust ${timeToExhaustMs}ms <= heavy ${thresholds.heavy}ms`,
    });
  }
  if (timeToExhaustMs <= thresholds.light) {
    return Object.freeze({
      level: 'LIGHT' as ThrottleLevel,
      reason: `timeToExhaust ${timeToExhaustMs}ms <= light ${thresholds.light}ms`,
    });
  }
  return Object.freeze({
    level: 'NONE' as ThrottleLevel,
    reason: `timeToExhaust ${timeToExhaustMs}ms above all thresholds`,
  });
}

function evaluateSeverityFloor(
  severity: BudgetSeverity,
  floorMap: ThrottleConfig['severityFloor'],
): ThrottleAxisResult {
  const level = floorMap[severity];
  return Object.freeze({
    level,
    reason: `severity ${severity} → floor ${level}`,
  });
}

// =============================================================================
// Main Functions
// =============================================================================

/**
 * Compute throttle state from budget prediction and severity.
 * Takes the strictest (highest) level across all axes.
 */
export function computeThrottle(
  prediction: BudgetPrediction,
  severity: BudgetSeverity,
  config: ThrottleConfig = DEFAULT_THROTTLE_CONFIG,
): ThrottleState {
  // Fail-closed on any non-finite required field
  const hasInvalidInput = !Number.isFinite(prediction.currentRatio) ||
    !Number.isFinite(prediction.timeToExhaustMs) ||
    !Number.isFinite(prediction.confidence);
  if (config.failClosedOnInvalidInput && hasInvalidInput) {
    const failAxis: ThrottleAxisResult = Object.freeze({
      level: 'STOPPED' as ThrottleLevel,
      reason: 'fail-closed: invalid prediction input',
    });
    const axes = Object.freeze({
      ratio: failAxis,
      time: failAxis,
      severityFloor: failAxis,
      selectedBy: 'ratio' as const,
    });
    return Object.freeze({
      level: 'STOPPED' as ThrottleLevel,
      rate: RATE_MAP.STOPPED,
      axes,
      override: null,
      ui: buildUiStatus('STOPPED', axes),
    });
  }

  const ratioResult = evaluateRatioAxis(prediction.currentRatio, config.ratioThresholds);
  const timeResult = evaluateTimeAxis(
    prediction.timeToExhaustMs,
    prediction.confidence,
    config.minConfidence,
    config.timeThresholds,
  );
  const floorResult = evaluateSeverityFloor(severity, config.severityFloor);

  // Take strictest level
  let level = maxLevel(ratioResult.level, timeResult.level);
  level = maxLevel(level, floorResult.level);

  // Determine which axis was decisive
  let selectedBy: ThrottleState['axes']['selectedBy'];
  if (LEVEL_PRIORITY[floorResult.level] >= LEVEL_PRIORITY[ratioResult.level] &&
      LEVEL_PRIORITY[floorResult.level] >= LEVEL_PRIORITY[timeResult.level] &&
      floorResult.level !== 'NONE') {
    selectedBy = 'severity_floor';
  } else if (LEVEL_PRIORITY[ratioResult.level] >= LEVEL_PRIORITY[timeResult.level]) {
    selectedBy = 'ratio';
  } else {
    selectedBy = 'time';
  }

  const axes = Object.freeze({
    ratio: ratioResult,
    time: timeResult,
    severityFloor: floorResult,
    selectedBy,
  });

  return Object.freeze({
    level,
    rate: RATE_MAP[level],
    axes,
    override: null,
    ui: buildUiStatus(level, axes),
  });
}

/**
 * Apply a manual override to an existing throttle state.
 * Returns new state (immutable). Expired overrides are ignored.
 */
export function applyOverride(
  state: ThrottleState,
  override: ThrottleOverride,
  nowMs: number,
): ThrottleState {
  // Check expiry
  if (override.expiresAt > 0 && nowMs >= override.expiresAt) {
    // Override expired — return original state unchanged
    return state;
  }

  let level: ThrottleLevel;
  if (override.action === 'BYPASS') {
    level = 'NONE';
  } else if (override.action === 'FORCE_LEVEL' && override.forceLevel) {
    level = override.forceLevel;
  } else {
    // Invalid override — fail-closed, keep original state
    return state;
  }

  const frozenOverride = Object.freeze({ ...override });
  const axes = Object.freeze({
    ...state.axes,
    selectedBy: 'override' as const,
  });

  return Object.freeze({
    level,
    rate: RATE_MAP[level],
    axes,
    override: frozenOverride,
    ui: buildUiStatus(level, axes),
  });
}
