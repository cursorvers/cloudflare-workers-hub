import type { Env } from '../../../types';
import { doFetch } from '../../../utils/do-fetch';
import {
  authenticateBearer,
  verifyWebhookSignature,
} from '../auth';

const WEBHOOK_MAX_AGE_MS = 5 * 60 * 1000;

const JSON_HEADERS = { 'Content-Type': 'application/json' };

type RouteAuth = 'bearer' | 'webhook';

interface RouteDefinition {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly doPath: string;
  readonly auth: RouteAuth;
}

const ROUTES: readonly RouteDefinition[] = Object.freeze([
  { method: 'GET', path: '/api/autopilot/status', doPath: '/status', auth: 'bearer' },
  { method: 'POST', path: '/api/autopilot/transition', doPath: '/transition', auth: 'bearer' },
  { method: 'POST', path: '/api/autopilot/recovery', doPath: '/recovery', auth: 'bearer' },
  { method: 'POST', path: '/api/autopilot/heartbeat', doPath: '/heartbeat', auth: 'bearer' },
  { method: 'POST', path: '/api/autopilot/budget', doPath: '/budget', auth: 'bearer' },
  { method: 'POST', path: '/api/autopilot/webhook', doPath: '/webhook', auth: 'webhook' },
  { method: 'POST', path: '/api/autopilot/circuit/success', doPath: '/circuit/success', auth: 'bearer' },
  { method: 'POST', path: '/api/autopilot/circuit/failure', doPath: '/circuit/failure', auth: 'bearer' },
  { method: 'POST', path: '/api/autopilot/execute', doPath: '/execute', auth: 'bearer' },
]);

function resolveCorsHeaders(request: Request): Record<string, string> {
  const requestOrigin = new URL(request.url).origin;
  const origin = request.headers.get('Origin') || '';
  const allowedOrigins = [
    requestOrigin,
    'https://orchestrator-hub.masa-stage1.workers.dev',
    'https://orchestrator-hub-production.masa-stage1.workers.dev',
    'https://orchestrator-hub-canary.masa-stage1.workers.dev',
    'https://fugue-system-ui.vercel.app',
    'https://cockpit-pwa.vercel.app',
    'http://localhost:3000',
    'http://localhost:8787',
  ];
  const allowOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];

  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': [
      'Content-Type',
      'Authorization',
      'X-Autopilot-Signature',
      'X-Autopilot-Timestamp',
    ].join(', '),
    'Access-Control-Allow-Credentials': 'true',
  };
}

function withCors(response: Response, corsHeaders: Record<string, string>): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders)) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function findRoute(path: string, method: string): RouteDefinition | null {
  for (const route of ROUTES) {
    if (route.path === path && route.method === method) {
      return route;
    }
  }
  return null;
}

function unauthorizedResponse(reason: string): Response {
  return new Response(JSON.stringify({ error: 'Unauthorized', reason }), {
    status: 401,
    headers: JSON_HEADERS,
  });
}

async function verifyBearerAuth(request: Request, env: Env): Promise<Response | null> {
  const expectedToken = env.AUTOPILOT_API_KEY?.trim();
  if (!expectedToken) {
    return new Response(JSON.stringify({ error: 'AUTOPILOT_API_KEY is not configured' }), {
      status: 503,
      headers: JSON_HEADERS,
    });
  }

  const result = authenticateBearer(
    request.headers.get('Authorization'),
    [expectedToken],
  );

  if (!result.authenticated) {
    return unauthorizedResponse(result.reason);
  }

  return null;
}

async function verifyWebhookAuth(request: Request, env: Env, body: string): Promise<Response | null> {
  const secret = env.AUTOPILOT_WEBHOOK_SECRET?.trim();
  if (!secret) {
    return new Response(JSON.stringify({ error: 'AUTOPILOT_WEBHOOK_SECRET is not configured' }), {
      status: 503,
      headers: JSON_HEADERS,
    });
  }

  const signature = request.headers.get('X-Autopilot-Signature')
    ?? request.headers.get('X-Signature')
    ?? '';
  const timestamp = request.headers.get('X-Autopilot-Timestamp')
    ?? request.headers.get('X-Timestamp')
    ?? '';

  const verification = await verifyWebhookSignature(
    body,
    signature,
    secret,
    timestamp,
    { maxAgeMs: WEBHOOK_MAX_AGE_MS },
  );

  if (!verification.valid) {
    return unauthorizedResponse(verification.reason);
  }

  return null;
}

async function proxyToCoordinator(
  request: Request,
  env: Env,
  doPath: string,
  body: string | null,
): Promise<Response> {
  if (!env.AUTOPILOT_COORDINATOR) {
    return new Response(JSON.stringify({ error: 'AUTOPILOT_COORDINATOR is not configured' }), {
      status: 503,
      headers: JSON_HEADERS,
    });
  }

  const id = env.AUTOPILOT_COORDINATOR.idFromName('autopilot');
  const stub = env.AUTOPILOT_COORDINATOR.get(id);

  const headers = new Headers(request.headers);
  if (env.AUTOPILOT_API_KEY) {
    headers.set('Authorization', `Bearer ${env.AUTOPILOT_API_KEY}`);
  }

  return doFetch(stub, `https://autopilot-do${doPath}`, {
    method: request.method,
    headers,
    body: body ?? undefined,
  });
}

export async function handleAutopilotAPI(
  request: Request,
  env: Env,
  path: string,
): Promise<Response> {
  const corsHeaders = resolveCorsHeaders(request);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const route = findRoute(path, request.method);
  if (!route) {
    return withCors(new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: JSON_HEADERS,
    }), corsHeaders);
  }

  const body = request.method === 'POST' ? await request.text() : null;

  const authFailure = route.auth === 'bearer'
    ? await verifyBearerAuth(request, env)
    : await verifyWebhookAuth(request, env, body ?? '');
  if (authFailure) {
    return withCors(authFailure, corsHeaders);
  }

  const response = await proxyToCoordinator(request, env, route.doPath, body);
  return withCors(response, corsHeaders);
}
