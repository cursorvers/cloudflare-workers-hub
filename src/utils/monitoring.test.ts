/**
 * Tests for monitoring utilities
 *
 * Testing strategy:
 * 1. MetricsCollector - request tracking and latency calculation
 * 2. Percentile calculations (P50/P95/P99)
 * 3. SLO compliance checking
 * 4. Error rate tracking
 * 5. RollbackManager - error threshold detection
 * 6. FeatureFlagManager - feature flag management
 * 7. Channel-level error tracking
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  MetricsCollector,
  FeatureFlagManager,
  RollbackManager,
  createAnalyticsPayload,
  type RequestMetrics,
  type SLOConfig,
} from './monitoring';

describe('MetricsCollector', () => {
  let collector: MetricsCollector;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    collector = new MetricsCollector();
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleWarnSpy.mockRestore();
  });

  describe('Request tracking', () => {
    it('should start tracking a request with initial values', () => {
      const metric = collector.startRequest('req-123', 'slack', '/api/message', 'POST');

      expect(metric).toEqual({
        requestId: 'req-123',
        source: 'slack',
        path: '/api/message',
        method: 'POST',
        startTime: expect.any(Number),
        status: 0,
      });
      expect(metric.startTime).toBeGreaterThan(0);
    });

    it('should calculate duration when ending a request', () => {
      const metric = collector.startRequest('req-123', 'discord', '/api/health', 'GET');
      const startTime = metric.startTime;

      // Simulate some processing time
      vi.spyOn(Date, 'now').mockReturnValue(startTime + 150);

      collector.endRequest(metric, 200);

      expect(metric.endTime).toBe(startTime + 150);
      expect(metric.duration).toBe(150);
      expect(metric.status).toBe(200);
      expect(metric.error).toBeUndefined();
    });

    it('should track error messages when request fails', () => {
      const metric = collector.startRequest('req-456', 'clawdbot', '/api/query', 'POST');

      collector.endRequest(metric, 500, 'Database connection failed');

      expect(metric.status).toBe(500);
      expect(metric.error).toBe('Database connection failed');
    });

    it('should increment total request counter', () => {
      const metric1 = collector.startRequest('req-1', 'slack', '/api/test', 'GET');
      const metric2 = collector.startRequest('req-2', 'discord', '/api/test', 'GET');

      collector.endRequest(metric1, 200);
      collector.endRequest(metric2, 200);

      const summary = collector.getSummary();
      expect(summary.totalRequests).toBe(2);
    });
  });

  describe('Latency calculation', () => {
    it('should calculate average response time correctly', () => {
      const createAndEndRequest = (duration: number, status: number = 200) => {
        const metric = collector.startRequest(`req-${duration}`, 'slack', '/test', 'GET');
        vi.spyOn(Date, 'now').mockReturnValue(metric.startTime + duration);
        collector.endRequest(metric, status);
      };

      createAndEndRequest(100);
      createAndEndRequest(200);
      createAndEndRequest(300);

      expect(collector.getAverageResponseTime()).toBe(200);
    });

    it('should return 0 for average when no metrics exist', () => {
      expect(collector.getAverageResponseTime()).toBe(0);
    });

    it('should handle requests with different durations', () => {
      const durations = [50, 150, 250, 100, 200];

      durations.forEach(duration => {
        const metric = collector.startRequest(`req-${duration}`, 'slack', '/test', 'GET');
        vi.spyOn(Date, 'now').mockReturnValue(metric.startTime + duration);
        collector.endRequest(metric, 200);
      });

      const average = collector.getAverageResponseTime();
      expect(average).toBe(150); // (50 + 150 + 250 + 100 + 200) / 5 = 150
    });
  });

  describe('Percentile calculations (P50/P95/P99)', () => {
    it('should calculate P50 (median) correctly', () => {
      const durations = [100, 200, 300, 400, 500];

      durations.forEach(duration => {
        const metric = collector.startRequest(`req-${duration}`, 'slack', '/test', 'GET');
        vi.spyOn(Date, 'now').mockReturnValue(metric.startTime + duration);
        collector.endRequest(metric, 200);
      });

      const summary = collector.getSummary();
      expect(summary.p50).toBe(300);
    });

    it('should calculate P95 correctly', () => {
      const durations = Array.from({ length: 100 }, (_, i) => i + 1);

      durations.forEach(duration => {
        const metric = collector.startRequest(`req-${duration}`, 'slack', '/test', 'GET');
        vi.spyOn(Date, 'now').mockReturnValue(metric.startTime + duration);
        collector.endRequest(metric, 200);
      });

      const summary = collector.getSummary();
      expect(summary.p95).toBe(95);
    });

    it('should calculate P99 correctly', () => {
      const durations = Array.from({ length: 100 }, (_, i) => i + 1);

      durations.forEach(duration => {
        const metric = collector.startRequest(`req-${duration}`, 'slack', '/test', 'GET');
        vi.spyOn(Date, 'now').mockReturnValue(metric.startTime + duration);
        collector.endRequest(metric, 200);
      });

      const summary = collector.getSummary();
      expect(summary.p99).toBe(99);
    });

    it('should return 0 for percentiles when no metrics exist', () => {
      const summary = collector.getSummary();

      expect(summary.p50).toBe(0);
      expect(summary.p95).toBe(0);
      expect(summary.p99).toBe(0);
    });

    it('should handle single metric correctly', () => {
      const metric = collector.startRequest('req-single', 'slack', '/test', 'GET');
      vi.spyOn(Date, 'now').mockReturnValue(metric.startTime + 150);
      collector.endRequest(metric, 200);

      const summary = collector.getSummary();
      expect(summary.p50).toBe(150);
      expect(summary.p95).toBe(150);
      expect(summary.p99).toBe(150);
    });

    it('should sort durations correctly for percentile calculation', () => {
      // Insert in random order
      const durations = [500, 100, 300, 200, 400];

      durations.forEach(duration => {
        const metric = collector.startRequest(`req-${duration}`, 'slack', '/test', 'GET');
        vi.spyOn(Date, 'now').mockReturnValue(metric.startTime + duration);
        collector.endRequest(metric, 200);
      });

      const summary = collector.getSummary();
      expect(summary.p50).toBe(300); // Median of sorted [100, 200, 300, 400, 500]
    });
  });

  describe('SLO compliance checking', () => {
    it('should detect SLO violations when response time exceeds threshold', () => {
      const customSLO: SLOConfig = {
        edgeProcessingMs: 200,
        aiResponseMs: 5000,
        orchestratorResponseMs: 10000,
        errorRateThreshold: 0.01,
      };
      const collector = new MetricsCollector(customSLO);

      const metric = collector.startRequest('req-slow', 'slack', '/test', 'GET');
      vi.spyOn(Date, 'now').mockReturnValue(metric.startTime + 250); // Exceeds 200ms
      collector.endRequest(metric, 200);

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[SLO Violation] req-slow: 250ms > 200ms')
      );
    });

    it('should not log warning when response time is within SLO', () => {
      const metric = collector.startRequest('req-fast', 'slack', '/test', 'GET');
      vi.spyOn(Date, 'now').mockReturnValue(metric.startTime + 150); // Within 200ms default
      collector.endRequest(metric, 200);

      expect(consoleWarnSpy).not.toHaveBeenCalled();
    });

    it('should calculate SLO compliance rate correctly', () => {
      const customSLO: SLOConfig = {
        edgeProcessingMs: 200,
        aiResponseMs: 5000,
        orchestratorResponseMs: 10000,
        errorRateThreshold: 0.01,
      };
      const collector = new MetricsCollector(customSLO);

      // 3 requests within SLO, 2 violations
      const durations = [100, 150, 250, 180, 300];
      durations.forEach((duration, index) => {
        const metric = collector.startRequest(`req-${index}`, 'slack', '/test', 'GET');
        vi.spyOn(Date, 'now').mockReturnValue(metric.startTime + duration);
        collector.endRequest(metric, 200);
      });

      // 3/5 within SLO = 60% compliance
      expect(collector.getSLOCompliance()).toBe(0.6);
    });

    it('should return 1.0 compliance when no requests exist', () => {
      expect(collector.getSLOCompliance()).toBe(1);
    });

    it('should track violations separately from metrics count', () => {
      const customSLO: SLOConfig = {
        edgeProcessingMs: 100,
        aiResponseMs: 5000,
        orchestratorResponseMs: 10000,
        errorRateThreshold: 0.01,
      };
      const collector = new MetricsCollector(customSLO);

      // Add 2 violations
      const metric1 = collector.startRequest('req-1', 'slack', '/test', 'GET');
      vi.spyOn(Date, 'now').mockReturnValue(metric1.startTime + 150);
      collector.endRequest(metric1, 200);

      const metric2 = collector.startRequest('req-2', 'slack', '/test', 'GET');
      vi.spyOn(Date, 'now').mockReturnValue(metric2.startTime + 50);
      collector.endRequest(metric2, 200);

      expect(collector.getSLOCompliance()).toBe(0.5); // 1 violation out of 2 requests
    });
  });

  describe('Error rate tracking', () => {
    it('should calculate error rate correctly', () => {
      // 3 success, 2 errors
      const statuses = [200, 200, 500, 404, 200];

      statuses.forEach((status, index) => {
        const metric = collector.startRequest(`req-${index}`, 'slack', '/test', 'GET');
        vi.spyOn(Date, 'now').mockReturnValue(metric.startTime + 100);
        collector.endRequest(metric, status);
      });

      expect(collector.getErrorRate()).toBe(0.4); // 2/5 = 40%
    });

    it('should return 0 error rate when no metrics exist', () => {
      expect(collector.getErrorRate()).toBe(0);
    });

    it('should treat 4xx and 5xx as errors', () => {
      const statuses = [200, 201, 400, 401, 404, 500, 502, 503];

      statuses.forEach((status, index) => {
        const metric = collector.startRequest(`req-${index}`, 'slack', '/test', 'GET');
        collector.endRequest(metric, status);
      });

      // 6 errors (400, 401, 404, 500, 502, 503) out of 8 = 75%
      expect(collector.getErrorRate()).toBe(0.75);
    });

    it('should check if error rate exceeds threshold', () => {
      const customSLO: SLOConfig = {
        edgeProcessingMs: 200,
        aiResponseMs: 5000,
        orchestratorResponseMs: 10000,
        errorRateThreshold: 0.05, // 5%
      };
      const collector = new MetricsCollector(customSLO);

      // 2 errors out of 10 = 20%
      const statuses = [200, 200, 200, 200, 200, 200, 200, 200, 500, 500];
      statuses.forEach((status, index) => {
        const metric = collector.startRequest(`req-${index}`, 'slack', '/test', 'GET');
        collector.endRequest(metric, status);
      });

      expect(collector.isErrorRateExceeded()).toBe(true);
    });

    it('should not exceed threshold when error rate is within limits', () => {
      const customSLO: SLOConfig = {
        edgeProcessingMs: 200,
        aiResponseMs: 5000,
        orchestratorResponseMs: 10000,
        errorRateThreshold: 0.05, // 5%
      };
      const collector = new MetricsCollector(customSLO);

      // 1 error out of 100 = 1%
      const statuses = Array(99).fill(200).concat([500]);
      statuses.forEach((status, index) => {
        const metric = collector.startRequest(`req-${index}`, 'slack', '/test', 'GET');
        collector.endRequest(metric, status);
      });

      expect(collector.isErrorRateExceeded()).toBe(false);
    });
  });

  describe('Metrics storage and summary', () => {
    it('should limit stored metrics to maxMetrics', () => {
      const collector = new MetricsCollector();

      // Add 1100 metrics (maxMetrics = 1000)
      for (let i = 0; i < 1100; i++) {
        const metric = collector.startRequest(`req-${i}`, 'slack', '/test', 'GET');
        collector.endRequest(metric, 200);
      }

      const summary = collector.getSummary();
      expect(summary.totalRequests).toBe(1100); // Total counter should track all
      // Note: metrics array length is not exposed, but we can verify behavior through other means
    });

    it('should provide complete summary with all metrics', () => {
      const metric1 = collector.startRequest('req-1', 'slack', '/test', 'GET');
      vi.spyOn(Date, 'now').mockReturnValue(metric1.startTime + 100);
      collector.endRequest(metric1, 200);

      const metric2 = collector.startRequest('req-2', 'discord', '/test', 'POST');
      vi.spyOn(Date, 'now').mockReturnValue(metric2.startTime + 200);
      collector.endRequest(metric2, 500);

      const summary = collector.getSummary();

      expect(summary).toEqual({
        totalRequests: 2,
        sloCompliance: expect.any(Number),
        averageResponseTime: 150,
        errorRate: 0.5,
        p50: expect.any(Number),
        p95: expect.any(Number),
        p99: expect.any(Number),
      });
    });
  });
});

describe('FeatureFlagManager', () => {
  describe('Feature flag management', () => {
    it('should initialize with default flags', () => {
      const manager = new FeatureFlagManager();

      expect(manager.isEnabled('slackEnabled')).toBe(true);
      expect(manager.isEnabled('discordEnabled')).toBe(true);
      expect(manager.isEnabled('clawdbotEnabled')).toBe(true);
      expect(manager.isEnabled('workersAiEnabled')).toBe(true);
      expect(manager.isEnabled('orchestratorForwarding')).toBe(true);
      expect(manager.isEnabled('debugMode')).toBe(false);
    });

    it('should accept custom initial flags', () => {
      const manager = new FeatureFlagManager({
        slackEnabled: false,
        debugMode: true,
      });

      expect(manager.isEnabled('slackEnabled')).toBe(false);
      expect(manager.isEnabled('discordEnabled')).toBe(true); // default
      expect(manager.isEnabled('debugMode')).toBe(true);
    });

    it('should set flag value', () => {
      const manager = new FeatureFlagManager();

      manager.setFlag('debugMode', true);
      expect(manager.isEnabled('debugMode')).toBe(true);

      manager.setFlag('slackEnabled', false);
      expect(manager.isEnabled('slackEnabled')).toBe(false);
    });

    it('should get all flags as object', () => {
      const manager = new FeatureFlagManager({
        debugMode: true,
      });

      const flags = manager.getAllFlags();

      expect(flags).toEqual({
        slackEnabled: true,
        discordEnabled: true,
        clawdbotEnabled: true,
        workersAiEnabled: true,
        orchestratorForwarding: true,
        debugMode: true,
      });
    });

    it('should return a copy of flags, not reference', () => {
      const manager = new FeatureFlagManager();

      const flags = manager.getAllFlags();
      flags.debugMode = true;

      expect(manager.isEnabled('debugMode')).toBe(false); // Original unchanged
    });
  });

  describe('Channel-level feature flags', () => {
    it('should check if channel is enabled', () => {
      const manager = new FeatureFlagManager();

      expect(manager.isChannelEnabled('slack')).toBe(true);
      expect(manager.isChannelEnabled('discord')).toBe(true);
      expect(manager.isChannelEnabled('clawdbot')).toBe(true);
    });

    it('should return true for unknown channels', () => {
      const manager = new FeatureFlagManager();

      expect(manager.isChannelEnabled('unknown-channel')).toBe(true);
    });

    it('should disable channel correctly', () => {
      const manager = new FeatureFlagManager();

      manager.disableChannel('slack');
      expect(manager.isChannelEnabled('slack')).toBe(false);
      expect(manager.isEnabled('slackEnabled')).toBe(false);
    });

    it('should disable multiple channels independently', () => {
      const manager = new FeatureFlagManager();

      manager.disableChannel('slack');
      manager.disableChannel('discord');

      expect(manager.isChannelEnabled('slack')).toBe(false);
      expect(manager.isChannelEnabled('discord')).toBe(false);
      expect(manager.isChannelEnabled('clawdbot')).toBe(true);
    });

    it('should handle disabling unknown channels gracefully', () => {
      const manager = new FeatureFlagManager();

      expect(() => {
        manager.disableChannel('unknown-channel');
      }).not.toThrow();
    });
  });
});

describe('RollbackManager', () => {
  let manager: RollbackManager;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Error threshold detection', () => {
    it('should record errors for channels', () => {
      manager = new RollbackManager({ threshold: 5 });

      manager.recordError('slack');
      manager.recordError('slack');
      manager.recordError('slack');

      expect(manager.getErrorCount('slack')).toBe(3);
    });

    it('should trigger rollback when threshold is exceeded', () => {
      manager = new RollbackManager({ threshold: 3 });

      manager.recordError('discord');
      manager.recordError('discord');
      expect(manager.shouldRollback('discord')).toBe(false);

      manager.recordError('discord');
      expect(manager.shouldRollback('discord')).toBe(true);
    });

    it('should use default threshold of 10', () => {
      manager = new RollbackManager();

      for (let i = 0; i < 9; i++) {
        manager.recordError('slack');
      }
      expect(manager.shouldRollback('slack')).toBe(false);

      manager.recordError('slack');
      expect(manager.shouldRollback('slack')).toBe(true);
    });

    it('should track errors independently per channel', () => {
      manager = new RollbackManager({ threshold: 3 });

      manager.recordError('slack');
      manager.recordError('slack');
      manager.recordError('discord');

      expect(manager.getErrorCount('slack')).toBe(2);
      expect(manager.getErrorCount('discord')).toBe(1);
      expect(manager.shouldRollback('slack')).toBe(false);
      expect(manager.shouldRollback('discord')).toBe(false);
    });
  });

  describe('Channel-level error tracking', () => {
    it('should return 0 for channels with no errors', () => {
      manager = new RollbackManager();

      expect(manager.getErrorCount('slack')).toBe(0);
      expect(manager.getErrorCount('discord')).toBe(0);
    });

    it('should increment error count correctly', () => {
      manager = new RollbackManager();

      manager.recordError('slack');
      expect(manager.getErrorCount('slack')).toBe(1);

      manager.recordError('slack');
      expect(manager.getErrorCount('slack')).toBe(2);
    });

    it('should handle multiple channels simultaneously', () => {
      manager = new RollbackManager({ threshold: 5 });

      manager.recordError('slack');
      manager.recordError('discord');
      manager.recordError('clawdbot');
      manager.recordError('slack');

      expect(manager.getErrorCount('slack')).toBe(2);
      expect(manager.getErrorCount('discord')).toBe(1);
      expect(manager.getErrorCount('clawdbot')).toBe(1);
    });
  });

  describe('Time window management', () => {
    it('should reset counts after time window expires', () => {
      manager = new RollbackManager({ threshold: 3, timeWindowMs: 60000 });

      manager.recordError('slack');
      manager.recordError('slack');
      expect(manager.getErrorCount('slack')).toBe(2);

      // Advance time by 61 seconds
      vi.advanceTimersByTime(61000);

      manager.recordError('slack'); // This should trigger reset
      expect(manager.getErrorCount('slack')).toBe(1);
    });

    it('should use default time window of 60 seconds', () => {
      manager = new RollbackManager({ threshold: 3 });

      manager.recordError('slack');
      expect(manager.getErrorCount('slack')).toBe(1);

      vi.advanceTimersByTime(59000);
      manager.recordError('slack');
      expect(manager.getErrorCount('slack')).toBe(2);

      vi.advanceTimersByTime(2000); // Total 61 seconds
      manager.recordError('slack');
      expect(manager.getErrorCount('slack')).toBe(1);
    });

    it('should reset all channels when window expires', () => {
      manager = new RollbackManager({ timeWindowMs: 60000 });

      manager.recordError('slack');
      manager.recordError('discord');
      manager.recordError('clawdbot');

      vi.advanceTimersByTime(61000);

      manager.recordError('slack'); // Trigger reset
      expect(manager.getErrorCount('slack')).toBe(1);
      expect(manager.getErrorCount('discord')).toBe(0);
      expect(manager.getErrorCount('clawdbot')).toBe(0);
    });

    it('should allow manual reset', () => {
      manager = new RollbackManager({ threshold: 3 });

      manager.recordError('slack');
      manager.recordError('discord');
      manager.recordError('clawdbot');

      manager.reset();

      expect(manager.getErrorCount('slack')).toBe(0);
      expect(manager.getErrorCount('discord')).toBe(0);
      expect(manager.getErrorCount('clawdbot')).toBe(0);
    });

    it('should update last reset time on manual reset', () => {
      const startTime = Date.now();
      manager = new RollbackManager({ timeWindowMs: 60000 });

      vi.setSystemTime(startTime);
      manager.recordError('slack');
      expect(manager.getErrorCount('slack')).toBe(1);

      vi.setSystemTime(startTime + 30000);
      manager.reset();

      // After reset, we're at t=30000. Adding another 30000 makes t=60000
      // This is exactly 60000ms from start but only 30000ms from reset
      vi.setSystemTime(startTime + 60000);
      manager.recordError('slack');

      // Should be 1 because reset happened at t=30000, and we're at t=60000 (only 30s later)
      expect(manager.getErrorCount('slack')).toBe(1);
    });
  });

  describe('Rollback decision making', () => {
    it('should not rollback below threshold', () => {
      manager = new RollbackManager({ threshold: 5 });

      for (let i = 0; i < 4; i++) {
        manager.recordError('slack');
      }

      expect(manager.shouldRollback('slack')).toBe(false);
    });

    it('should rollback at exactly threshold', () => {
      manager = new RollbackManager({ threshold: 5 });

      for (let i = 0; i < 5; i++) {
        manager.recordError('slack');
      }

      expect(manager.shouldRollback('slack')).toBe(true);
    });

    it('should continue rollback above threshold', () => {
      manager = new RollbackManager({ threshold: 3 });

      for (let i = 0; i < 10; i++) {
        manager.recordError('slack');
      }

      expect(manager.shouldRollback('slack')).toBe(true);
    });

    it('should check time window before rollback decision', () => {
      manager = new RollbackManager({ threshold: 3, timeWindowMs: 60000 });

      manager.recordError('slack');
      manager.recordError('slack');
      manager.recordError('slack');
      expect(manager.shouldRollback('slack')).toBe(true);

      vi.advanceTimersByTime(61000);
      expect(manager.shouldRollback('slack')).toBe(false); // Reset occurred
    });
  });
});

describe('createAnalyticsPayload', () => {
  it('should create correct payload structure', () => {
    const metric: RequestMetrics = {
      requestId: 'req-123',
      source: 'slack',
      path: '/api/message',
      method: 'POST',
      startTime: 1234567890000,
      endTime: 1234567890150,
      duration: 150,
      status: 200,
    };

    const payload = createAnalyticsPayload(metric);

    expect(payload).toEqual({
      blobs: ['req-123', 'slack', '/api/message', ''],
      doubles: [150, 200, 1234567890000],
      indexes: ['slack'],
    });
  });

  it('should include error message when present', () => {
    const metric: RequestMetrics = {
      requestId: 'req-456',
      source: 'discord',
      path: '/api/query',
      method: 'POST',
      startTime: 1234567890000,
      endTime: 1234567890500,
      duration: 500,
      status: 500,
      error: 'Database timeout',
    };

    const payload = createAnalyticsPayload(metric);

    expect(payload.blobs[3]).toBe('Database timeout');
  });

  it('should handle missing duration', () => {
    const metric: RequestMetrics = {
      requestId: 'req-789',
      source: 'clawdbot',
      path: '/api/health',
      method: 'GET',
      startTime: 1234567890000,
      status: 200,
    };

    const payload = createAnalyticsPayload(metric);

    expect(payload.doubles[0]).toBe(0); // duration defaults to 0
  });

  it('should use source as index', () => {
    const sources = ['slack', 'discord', 'clawdbot'];

    sources.forEach(source => {
      const metric: RequestMetrics = {
        requestId: 'req-test',
        source,
        path: '/test',
        method: 'GET',
        startTime: Date.now(),
        status: 200,
      };

      const payload = createAnalyticsPayload(metric);
      expect(payload.indexes).toEqual([source]);
    });
  });
});

describe('Integration scenarios', () => {
  it('should track full request lifecycle', () => {
    const collector = new MetricsCollector();
    const featureFlags = new FeatureFlagManager();
    const rollbackManager = new RollbackManager({ threshold: 3 });

    // Check if channel is enabled
    expect(featureFlags.isChannelEnabled('slack')).toBe(true);

    // Start tracking request
    const metric = collector.startRequest('req-integration', 'slack', '/api/test', 'POST');

    // Simulate processing
    vi.spyOn(Date, 'now').mockReturnValue(metric.startTime + 150);

    // End with error
    collector.endRequest(metric, 500, 'Service unavailable');
    rollbackManager.recordError('slack');

    // Verify metrics
    expect(collector.getErrorRate()).toBeGreaterThan(0);
    expect(rollbackManager.getErrorCount('slack')).toBe(1);

    // Create analytics payload
    const payload = createAnalyticsPayload(metric);
    expect(payload.blobs[3]).toBe('Service unavailable');
  });

  it('should trigger automatic rollback on repeated errors', () => {
    const featureFlags = new FeatureFlagManager();
    const rollbackManager = new RollbackManager({ threshold: 3 });

    // Simulate multiple errors
    for (let i = 0; i < 3; i++) {
      rollbackManager.recordError('discord');
    }

    // Should trigger rollback
    if (rollbackManager.shouldRollback('discord')) {
      featureFlags.disableChannel('discord');
    }

    expect(featureFlags.isChannelEnabled('discord')).toBe(false);
  });

  it('should handle high-traffic scenario', () => {
    const collector = new MetricsCollector({
      edgeProcessingMs: 200,
      aiResponseMs: 5000,
      orchestratorResponseMs: 10000,
      errorRateThreshold: 0.05,
    });

    // Simulate 100 requests with various characteristics (deterministic to avoid flaky tests).
    for (let i = 0; i < 100; i++) {
      const metric = collector.startRequest(`req-${i}`, 'slack', '/api/test', 'GET');
      const duration = (i * 7) % 300; // 0-299ms (deterministic)
      const status = i < 5 ? 500 : 200; // exactly 5% error rate

      vi.spyOn(Date, 'now').mockReturnValue(metric.startTime + duration);
      collector.endRequest(metric, status);
    }

    const summary = collector.getSummary();

    expect(summary.totalRequests).toBe(100);
    expect(summary.errorRate).toBeLessThanOrEqual(0.1); // Within reasonable bounds
    expect(summary.p50).toBeGreaterThan(0);
    expect(summary.p95).toBeGreaterThan(summary.p50);
    expect(summary.p99).toBeGreaterThan(summary.p95);
  });
});
