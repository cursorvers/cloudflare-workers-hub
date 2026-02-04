/**
 * Public WebSocket Worker
 *
 * Access を経由せずに CockpitWebSocket DO に接続するための
 * 公開エンドポイント。開発・テスト用。
 */

import { CockpitWebSocket } from './durable-objects/cockpit-websocket';

export { CockpitWebSocket };

interface Env {
  COCKPIT_WS: DurableObjectNamespace;
  ALLOW_ORIGINS: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': '*',
        },
      });
    }

    // Health check
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // WebSocket upgrade
    if (url.pathname === '/ws' && request.headers.get('Upgrade') === 'websocket') {
      // Check origin
      const origin = request.headers.get('Origin') || '';
      const allowedOrigins = (env.ALLOW_ORIGINS || '').split(',');
      const isAllowed = allowedOrigins.some(allowed => origin.includes(allowed));

      if (!isAllowed && env.ALLOW_ORIGINS) {
        return new Response('Forbidden: Origin not allowed', { status: 403 });
      }

      // Forward to Durable Object
      const doId = env.COCKPIT_WS.idFromName('cockpit');
      const doStub = env.COCKPIT_WS.get(doId);

      // Add dev-user headers for the DO
      const modifiedRequest = new Request(request.url.replace(url.pathname, '/ws'), {
        method: request.method,
        headers: new Headers([
          ...request.headers.entries(),
          ['X-Access-User-Id', 'public-ws-user'],
          ['X-Access-User-Role', 'operator'],
          ['X-Access-User-Email', 'public@ws.dev'],
        ]),
      });

      return doStub.fetch(modifiedRequest);
    }

    return new Response('Not found', { status: 404 });
  },
};
