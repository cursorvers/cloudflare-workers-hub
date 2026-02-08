/**
 * Health Check and Metrics Endpoints
 *
 * Provides monitoring endpoints for:
 * - System health status
 * - Performance metrics
 * - SLO compliance
 * - Feature flags status
 */

import { Env } from '../types';
import { metricsCollector, featureFlags, rollbackManager } from '../utils/monitoring';
import { safeLog } from '../utils/log-sanitizer';
import { verifyAPIKey } from '../utils/api-auth';

/**
 * Verify API Key for monitoring endpoints
 * Uses shared api-auth module for constant-time comparison.
 * If neither MONITORING_API_KEY nor ADMIN_API_KEY is configured, allows public access (for initial setup).
 */
function verifyMonitoringKey(request: Request, env: Env): boolean {
  // If no key configured, allow public access for initial setup
  if (!env.MONITORING_API_KEY && !env.ADMIN_API_KEY) {
    safeLog.warn('[Monitoring] No MONITORING_API_KEY or ADMIN_API_KEY configured - allowing public access');
    return true;
  }

  return verifyAPIKey(request, env, 'monitoring');
}

export async function handleHealthCheck(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const detailed = url.searchParams.get('detailed') === 'true';

  // If a monitoring/admin key is configured, require it for health as well.
  // Backward compatibility: if no key is configured, allow public access.
  if (!verifyMonitoringKey(request, env)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const metrics = metricsCollector.getSummary();

  const base = {
    status: metrics.errorRate > 0.1 ? 'degraded' : 'healthy',
    environment: env.ENVIRONMENT,
    timestamp: new Date().toISOString(),
    services: {
      ai: 'available',
      db: env.DB ? 'available' : 'not_configured',
      cache: env.CACHE ? 'available' : 'not_configured',
    },
  };

  if (!detailed) {
    return new Response(JSON.stringify(base), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const flags = featureFlags.getAllFlags();

  return new Response(JSON.stringify({
    ...base,
    metrics: {
      totalRequests: metrics.totalRequests,
      averageResponseTime: Math.round(metrics.averageResponseTime),
      sloCompliance: Math.round(metrics.sloCompliance * 100) + '%',
      errorRate: Math.round(metrics.errorRate * 100) + '%',
      p50: metrics.p50,
      p95: metrics.p95,
      p99: metrics.p99,
    },
    featureFlags: flags,
  }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function handleMetrics(request: Request, env: Env): Promise<Response> {
  // Verify API key with fallback to public access if not configured
  if (!verifyMonitoringKey(request, env)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const summary = metricsCollector.getSummary();
  const flags = featureFlags.getAllFlags();

  return new Response(JSON.stringify({
    timestamp: new Date().toISOString(),
    summary,
    flags,
    slo: {
      edgeProcessingTarget: '200ms',
      currentP95: summary.p95 + 'ms',
      compliant: summary.p95 <= 200,
    },
    channels: {
      slack: {
        enabled: flags.slackEnabled,
        errors: rollbackManager.getErrorCount('slack'),
      },
      discord: {
        enabled: flags.discordEnabled,
        errors: rollbackManager.getErrorCount('discord'),
      },
      clawdbot: {
        enabled: flags.clawdbotEnabled,
        errors: rollbackManager.getErrorCount('clawdbot'),
      },
    },
  }), {
    headers: { 'Content-Type': 'application/json' },
  });
}
