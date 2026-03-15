import { Env } from '../types';
import { authenticateWithAccess, mapAccessUserToInternal } from '../utils/cloudflare-access';
import { buildCorsHeaders } from '../utils/cors';
import { doFetch } from '../utils/do-fetch';
import { safeLog } from '../utils/log-sanitizer';

/**
 * Handle /api/notifications REST endpoints (SystemEvents DO).
 */
export async function handleNotificationsAPI(
  request: Request,
  env: Env,
  path: string,
  url: URL,
  workerOrigin: string,
): Promise<Response> {
  if (!env.SYSTEM_EVENTS) {
    return new Response(JSON.stringify({ error: 'Notification system not available' }), {
      status: 503, headers: { 'Content-Type': 'application/json' },
    });
  }

  const origin = request.headers.get('Origin') || '';
  const corsHeaders = buildCorsHeaders(
    origin,
    workerOrigin,
    'GET, POST, OPTIONS',
    'Content-Type, Authorization, X-Device-Id, X-API-Key',
  );

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // Authentication: Cloudflare Access or API Key
  const accessResult = await authenticateWithAccess(request, env);
  const apiKeyHeader = request.headers.get('X-API-Key');
  const tokenParam = url.searchParams.get('token');
  const isApiKeyAuth = env.QUEUE_API_KEY && (apiKeyHeader === env.QUEUE_API_KEY || tokenParam === env.QUEUE_API_KEY);

  if (!accessResult.verified && !isApiKeyAuth) {
    safeLog.log('[Notifications API] Auth failed', {
      accessVerified: accessResult.verified,
      hasApiKey: !!apiKeyHeader,
      hasToken: !!tokenParam,
    });
    return new Response(JSON.stringify({
      error: 'Unauthorized',
      message: 'Cloudflare Access or API key required',
    }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const doId = env.SYSTEM_EVENTS.idFromName('notifications');
  const doStub = env.SYSTEM_EVENTS.get(doId);

  // Map API paths to DO endpoints
  const subPath = path.replace('/api/notifications', '') || '/state';
  const response = await doFetch(doStub, new Request(`http://do${subPath}`, request));

  // Add CORS headers
  const newResponse = new Response(response.body, response);
  Object.entries(corsHeaders).forEach(([key, value]) => {
    newResponse.headers.set(key, value);
  });
  return newResponse;
}

/**
 * Handle WebSocket upgrade for Notifications (SystemEvents DO).
 */
export async function handleNotificationsWebSocket(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  if (!env.SYSTEM_EVENTS) {
    return new Response('Notification WebSocket not available', { status: 503 });
  }

  // Authentication: Cloudflare Access or API Key (via query param for WebSocket)
  const accessResult = await authenticateWithAccess(request, env);
  const tokenParam = url.searchParams.get('token');
  const isApiKeyAuth = env.QUEUE_API_KEY && tokenParam === env.QUEUE_API_KEY;

  if (!accessResult.verified && !isApiKeyAuth) {
    safeLog.log('[Notifications WS] Auth failed', {
      accessVerified: accessResult.verified,
      hasToken: !!tokenParam,
    });
    return new Response('Unauthorized: Cloudflare Access or API key required', { status: 401 });
  }

  const deviceId = url.searchParams.get('deviceId') || `device-${Date.now()}`;
  const doId = env.SYSTEM_EVENTS.idFromName('notifications');
  const doStub = env.SYSTEM_EVENTS.get(doId);

  return doStub.fetch(new Request(`http://do/ws?deviceId=${deviceId}`, request));
}

/**
 * Handle WebSocket upgrade for Cockpit (upgrade to DO).
 */
export async function handleCockpitWebSocket(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  if (!env.COCKPIT_WS) {
    return new Response('WebSocket not available', { status: 503 });
  }

  // Try Cloudflare Access authentication first
  const accessResult = await authenticateWithAccess(request, env);
  let authHeaders: Record<string, string> = {};

  safeLog.log('[WebSocket] Access auth attempt', {
    verified: accessResult.verified,
    email: accessResult.email,
    error: accessResult.error,
    hasCookie: request.headers.get('Cookie')?.includes('CF_Authorization') || false,
  });

  // Check for token-based auth as fallback (for PWA)
  const tokenParam = url.searchParams.get('token');
  const apiKeyHeader = request.headers.get('X-API-Key');
  let isTokenAuth = false;

  // Support both query param and X-API-Key header
  if (env.QUEUE_API_KEY && (tokenParam === env.QUEUE_API_KEY || apiKeyHeader === env.QUEUE_API_KEY)) {
    isTokenAuth = true;
    authHeaders = {
      'X-Access-User-Id': apiKeyHeader ? 'local-agent' : 'system',
      'X-Access-User-Role': 'operator',
    };
    safeLog.log('[WebSocket] API key auth passed', {
      method: apiKeyHeader ? 'header' : 'query',
    });
  }

  if (accessResult.verified && accessResult.email) {
    // Map Access user to internal user for RBAC
    const internalUser = await mapAccessUserToInternal(accessResult.email, env);
    if (internalUser) {
      // Pass user info via custom headers to DO
      authHeaders = {
        'X-Access-User-Id': internalUser.userId,
        'X-Access-User-Role': internalUser.role,
        'X-Access-User-Email': accessResult.email,
      };
      safeLog.log('[WebSocket] Access auth passed', {
        email: accessResult.email,
        role: internalUser.role,
      });
    }
  }

  // SECURITY: Require authentication for WebSocket connections
  if (!accessResult.verified && !isTokenAuth) {
    safeLog.warn('[WebSocket] Unauthorized connection attempt blocked');
    return new Response('Unauthorized: Authentication required for WebSocket', { status: 401 });
  }

  const doId = env.COCKPIT_WS.idFromName('cockpit');
  const doStub = env.COCKPIT_WS.get(doId);

  // Forward request to DO with auth headers
  return doStub.fetch(new Request(`http://do/ws${url.search}`, {
    headers: new Headers([
      ...Array.from(request.headers.entries()),
      ...Object.entries(authHeaders),
    ]),
  }));
}
