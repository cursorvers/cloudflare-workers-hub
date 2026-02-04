/**
 * Daemon Health API for Monitoring
 *
 * Provides endpoints for daemon lifecycle management:
 * - Register daemon
 * - Update heartbeat
 * - Get daemon health status
 */

import { Env } from '../types';
import { registerDaemon, updateHeartbeat, getDaemonHealth, DaemonRegistration, DaemonHeartbeat } from './daemon';
import { safeLog } from '../utils/log-sanitizer';
import { checkRateLimit, createRateLimitResponse } from '../utils/rate-limiter';
import { verifyAPIKey } from '../utils/api-auth';
import { validateRequestBody } from '../schemas/validation-helper';
import { DaemonRegistrationSchema, DaemonHeartbeatSchema } from '../schemas/daemon';

export async function handleDaemonAPI(request: Request, env: Env, path: string): Promise<Response> {
  // GET /api/daemon/health - List active daemons (queue scope - read-only)
  if (path === '/api/daemon/health' && request.method === 'GET') {
    // Health check uses queue scope (less restrictive than admin)
    if (!verifyAPIKey(request, env, 'queue')) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    try {
      const health = await getDaemonHealth(env);
      return new Response(JSON.stringify(health), {
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      safeLog.error('[Daemon API] Health check error', { error: String(error) });
      return new Response(JSON.stringify({
        error: 'Failed to get daemon health status',
        type: 'internal_error',
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  // Verify API key with admin scope (daemon endpoints are administrative)
  if (!verifyAPIKey(request, env, 'admin')) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Rate limit check
  const apiKey = request.headers.get('X-API-Key') || '';
  const rateLimitResult = await checkRateLimit(request, env, apiKey.substring(0, 8));
  if (!rateLimitResult.allowed) {
    return createRateLimitResponse(rateLimitResult);
  }

  // POST /api/daemon/register - Register daemon with heartbeat
  if (path === '/api/daemon/register' && request.method === 'POST') {
    try {
      const validation = await validateRequestBody(request, DaemonRegistrationSchema, '/api/daemon/register');
      if (!validation.success) {
        return validation.response;
      }

      const registration = validation.data as DaemonRegistration;
      const result = await registerDaemon(env, registration);
      return new Response(JSON.stringify(result), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      safeLog.error('[Daemon API] Register error', { error: String(error) });
      return new Response(JSON.stringify({
        error: 'Failed to register daemon',
        type: 'internal_error',
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  // POST /api/daemon/heartbeat - Update heartbeat timestamp
  if (path === '/api/daemon/heartbeat' && request.method === 'POST') {
    try {
      const validation = await validateRequestBody(request, DaemonHeartbeatSchema, '/api/daemon/heartbeat');
      if (!validation.success) {
        return validation.response;
      }

      const heartbeat = validation.data as DaemonHeartbeat;
      const result = await updateHeartbeat(env, heartbeat);

      if (!result.success) {
        return new Response(JSON.stringify({ error: 'Daemon not registered' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response(JSON.stringify(result), {
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      safeLog.error('[Daemon API] Heartbeat error', { error: String(error) });
      return new Response(JSON.stringify({
        error: 'Failed to update heartbeat',
        type: 'internal_error',
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  return new Response(JSON.stringify({ error: 'Not found' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json' },
  });
}
