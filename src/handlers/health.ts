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

/**
 * Verify API Key for monitoring endpoints with constant-time comparison
 * Falls back to ADMIN_API_KEY if MONITORING_API_KEY is not configured
 * If neither key is configured, allows public access (for initial setup)
 */
function verifyMonitoringKey(request: Request, env: Env): boolean {
  // Get monitoring key or fall back to admin key
  const expectedKey = env.MONITORING_API_KEY || env.ADMIN_API_KEY;

  // SECURITY: If no key configured, allow public access for initial setup
  // This provides backward compatibility while encouraging secure configuration
  if (!expectedKey) {
    safeLog.warn('[Monitoring] No MONITORING_API_KEY or ADMIN_API_KEY configured - allowing public access');
    return true;
  }

  const apiKey = request.headers.get('X-API-Key');
  if (!apiKey) {
    safeLog.warn('[Monitoring] Missing API key');
    return false;
  }

  // Constant-time comparison to prevent timing attacks
  // Always execute full comparison regardless of length to prevent timing leaks
  let result = apiKey.length === expectedKey.length ? 0 : 1;
  const maxLen = Math.max(apiKey.length, expectedKey.length);
  for (let i = 0; i < maxLen; i++) {
    const a = i < apiKey.length ? apiKey.charCodeAt(i) : 0;
    const b = i < expectedKey.length ? expectedKey.charCodeAt(i) : 0;
    result |= a ^ b;
  }

  if (result !== 0) {
    safeLog.warn('[Monitoring] Invalid API key');
    return false;
  }

  return true;
}

export async function handleHealthCheck(request: Request, env: Env): Promise<Response> {
  // Verify API key with fallback to public access if not configured
  if (!verifyMonitoringKey(request, env)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const metrics = metricsCollector.getSummary();
  const flags = featureFlags.getAllFlags();

  return new Response(JSON.stringify({
    status: metrics.errorRate > 0.1 ? 'degraded' : 'healthy',
    environment: env.ENVIRONMENT,
    timestamp: new Date().toISOString(),
    services: {
      ai: 'available',
      db: env.DB ? 'available' : 'not_configured',
      cache: env.CACHE ? 'available' : 'not_configured',
    },
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
