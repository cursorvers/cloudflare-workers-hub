/**
 * Monitoring & Analytics Utilities
 *
 * Phase 4: 最適化・監視
 * - Workers Analytics 統合
 * - SLO 監視
 * - Feature Flag
 * - 自動ロールバック
 */

import { safeLog } from './log-sanitizer';

export interface RequestMetrics {
  requestId: string;
  source: string;
  path: string;
  method: string;
  startTime: number;
  endTime?: number;
  duration?: number;
  status: number;
  error?: string;
}

export interface SLOConfig {
  edgeProcessingMs: number; // Target: <200ms
  aiResponseMs: number;
  orchestratorResponseMs: number;
  errorRateThreshold: number; // e.g., 0.01 = 1%
}

export interface FeatureFlags {
  slackEnabled: boolean;
  discordEnabled: boolean;
  clawdbotEnabled: boolean;
  workersAiEnabled: boolean;
  orchestratorForwarding: boolean;
  debugMode: boolean;
}

// Default SLO configuration
const DEFAULT_SLO: SLOConfig = {
  edgeProcessingMs: 200,
  aiResponseMs: 5000,
  orchestratorResponseMs: 10000,
  errorRateThreshold: 0.01,
};

// Default feature flags
const DEFAULT_FLAGS: FeatureFlags = {
  slackEnabled: true,
  discordEnabled: true,
  clawdbotEnabled: true,
  workersAiEnabled: true,
  orchestratorForwarding: true,
  debugMode: false,
};

/**
 * Metrics collector for request tracking
 */
export class MetricsCollector {
  private metrics: RequestMetrics[] = [];
  private maxMetrics: number = 1000;
  private sloConfig: SLOConfig;
  private sloViolations: number = 0;
  private totalRequests: number = 0;

  constructor(sloConfig: SLOConfig = DEFAULT_SLO) {
    this.sloConfig = sloConfig;
  }

  /**
   * Start tracking a request
   */
  startRequest(requestId: string, source: string, path: string, method: string): RequestMetrics {
    const metric: RequestMetrics = {
      requestId,
      source,
      path,
      method,
      startTime: Date.now(),
      status: 0,
    };
    return metric;
  }

  /**
   * End tracking a request
   */
  endRequest(metric: RequestMetrics, status: number, error?: string): void {
    metric.endTime = Date.now();
    metric.duration = metric.endTime - metric.startTime;
    metric.status = status;
    metric.error = error;

    this.totalRequests++;

    // Check SLO violation
    if (metric.duration > this.sloConfig.edgeProcessingMs) {
      this.sloViolations++;
      safeLog.warn(`[SLO Violation] ${metric.requestId}: ${metric.duration}ms > ${this.sloConfig.edgeProcessingMs}ms`);
    }

    // Store metric
    this.metrics.push(metric);
    if (this.metrics.length > this.maxMetrics) {
      this.metrics.shift(); // Remove oldest
    }
  }

  /**
   * Get SLO compliance rate
   */
  getSLOCompliance(): number {
    if (this.totalRequests === 0) return 1;
    return 1 - (this.sloViolations / this.totalRequests);
  }

  /**
   * Get average response time
   */
  getAverageResponseTime(): number {
    if (this.metrics.length === 0) return 0;
    const total = this.metrics.reduce((sum, m) => sum + (m.duration || 0), 0);
    return total / this.metrics.length;
  }

  /**
   * Get error rate
   */
  getErrorRate(): number {
    if (this.metrics.length === 0) return 0;
    const errors = this.metrics.filter(m => m.status >= 400).length;
    return errors / this.metrics.length;
  }

  /**
   * Get metrics summary
   */
  getSummary(): {
    totalRequests: number;
    sloCompliance: number;
    averageResponseTime: number;
    errorRate: number;
    p50: number;
    p95: number;
    p99: number;
  } {
    const durations = this.metrics
      .map(m => m.duration || 0)
      .sort((a, b) => a - b);

    const percentile = (p: number) => {
      if (durations.length === 0) return 0;
      const index = Math.ceil(durations.length * p) - 1;
      return durations[Math.max(0, index)];
    };

    return {
      totalRequests: this.totalRequests,
      sloCompliance: this.getSLOCompliance(),
      averageResponseTime: this.getAverageResponseTime(),
      errorRate: this.getErrorRate(),
      p50: percentile(0.5),
      p95: percentile(0.95),
      p99: percentile(0.99),
    };
  }

  /**
   * Check if error rate threshold is exceeded
   */
  isErrorRateExceeded(): boolean {
    return this.getErrorRate() > this.sloConfig.errorRateThreshold;
  }
}

/**
 * Feature flag manager
 */
export class FeatureFlagManager {
  private flags: FeatureFlags;

  constructor(initialFlags: Partial<FeatureFlags> = {}) {
    this.flags = { ...DEFAULT_FLAGS, ...initialFlags };
  }

  /**
   * Get feature flag value
   */
  isEnabled(flag: keyof FeatureFlags): boolean {
    return this.flags[flag];
  }

  /**
   * Set feature flag value
   */
  setFlag(flag: keyof FeatureFlags, value: boolean): void {
    this.flags[flag] = value;
  }

  /**
   * Get all flags
   */
  getAllFlags(): FeatureFlags {
    return { ...this.flags };
  }

  /**
   * Check if channel is enabled
   */
  isChannelEnabled(channel: string): boolean {
    switch (channel) {
      case 'slack':
        return this.flags.slackEnabled;
      case 'discord':
        return this.flags.discordEnabled;
      case 'clawdbot':
        return this.flags.clawdbotEnabled;
      default:
        return true;
    }
  }

  /**
   * Disable channel (for rollback)
   */
  disableChannel(channel: string): void {
    switch (channel) {
      case 'slack':
        this.flags.slackEnabled = false;
        break;
      case 'discord':
        this.flags.discordEnabled = false;
        break;
      case 'clawdbot':
        this.flags.clawdbotEnabled = false;
        break;
    }
  }
}

/**
 * Automatic rollback manager
 */
export class RollbackManager {
  private errorCounts: Map<string, number> = new Map();
  private rollbackThreshold: number;
  private timeWindowMs: number;
  private lastReset: number;

  constructor(options: { threshold?: number; timeWindowMs?: number } = {}) {
    this.rollbackThreshold = options.threshold ?? 10;
    this.timeWindowMs = options.timeWindowMs ?? 60000; // 1 minute
    this.lastReset = Date.now();
  }

  /**
   * Record an error for a channel
   */
  recordError(channel: string): void {
    this.maybeReset();
    const count = (this.errorCounts.get(channel) || 0) + 1;
    this.errorCounts.set(channel, count);
  }

  /**
   * Check if channel should be rolled back
   */
  shouldRollback(channel: string): boolean {
    this.maybeReset();
    const count = this.errorCounts.get(channel) || 0;
    return count >= this.rollbackThreshold;
  }

  /**
   * Get error count for a channel
   */
  getErrorCount(channel: string): number {
    this.maybeReset();
    return this.errorCounts.get(channel) || 0;
  }

  /**
   * Reset counts if time window expired
   */
  private maybeReset(): void {
    if (Date.now() - this.lastReset > this.timeWindowMs) {
      this.errorCounts.clear();
      this.lastReset = Date.now();
    }
  }

  /**
   * Manual reset
   */
  reset(): void {
    this.errorCounts.clear();
    this.lastReset = Date.now();
  }
}

/**
 * Create analytics payload for Cloudflare Analytics Engine
 */
export function createAnalyticsPayload(metric: RequestMetrics): {
  blobs: string[];
  doubles: number[];
  indexes: string[];
} {
  return {
    blobs: [
      metric.requestId,
      metric.source,
      metric.path,
      metric.error || '',
    ],
    doubles: [
      metric.duration || 0,
      metric.status,
      metric.startTime,
    ],
    indexes: [
      metric.source,
    ],
  };
}

// Export singleton instances for global state
export const metricsCollector = new MetricsCollector();
export const featureFlags = new FeatureFlagManager();
export const rollbackManager = new RollbackManager();

export default {
  MetricsCollector,
  FeatureFlagManager,
  RollbackManager,
  createAnalyticsPayload,
  metricsCollector,
  featureFlags,
  rollbackManager,
};
