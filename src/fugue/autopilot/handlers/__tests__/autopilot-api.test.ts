import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../../types';
import { handleAutopilotAPI } from '../autopilot-api';

async function sign(secret: string, timestamp: string, payload: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const digest = await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestamp}.${payload}`));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function createCoordinator(
  responseFactory?: (req: Request) => Promise<Response>,
): {
  namespace: DurableObjectNamespace;
  fetchSpy: ReturnType<typeof vi.fn>;
  idFromNameSpy: ReturnType<typeof vi.fn>;
  getSpy: ReturnType<typeof vi.fn>;
} {
  const fetchSpy = vi.fn().mockImplementation(async (req: Request) => {
    if (responseFactory) return responseFactory(req);
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });

  const stub = { fetch: fetchSpy } as unknown as DurableObjectStub;
  const idFromNameSpy = vi.fn().mockReturnValue('autopilot-id');
  const getSpy = vi.fn().mockReturnValue(stub);
  const namespace = {
    idFromName: idFromNameSpy,
    get: getSpy,
  } as unknown as DurableObjectNamespace;

  return { namespace, fetchSpy, idFromNameSpy, getSpy };
}

function createEnv(
  coordinator: DurableObjectNamespace,
  overrides: Partial<Env> = {},
): Env {
  return {
    AI: {} as Ai,
    ENVIRONMENT: 'test',
    AUTOPILOT_COORDINATOR: coordinator,
    AUTOPILOT_API_KEY: 'autopilot-api-key',
    AUTOPILOT_WEBHOOK_SECRET: 'autopilot-webhook-secret',
    ...overrides,
  };
}

describe('fugue/autopilot/handlers/autopilot-api', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('GET /status: Bearer 認証成功で DO /status にプロキシ', async () => {
    const coordinator = createCoordinator();
    const env = createEnv(coordinator.namespace);
    const request = new Request('https://example.com/api/autopilot/status', {
      method: 'GET',
      headers: {
        Authorization: 'Bearer autopilot-api-key',
        Origin: 'https://fugue-system-ui.vercel.app',
      },
    });

    const response = await handleAutopilotAPI(request, env, '/api/autopilot/status');
    const body = await response.json() as { success: boolean };

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://fugue-system-ui.vercel.app');

    expect(coordinator.idFromNameSpy).toHaveBeenCalledWith('autopilot');
    expect(coordinator.fetchSpy).toHaveBeenCalledTimes(1);
    const doRequest = coordinator.fetchSpy.mock.calls[0][0] as Request;
    expect(new URL(doRequest.url).pathname).toBe('/status');
    expect(doRequest.headers.get('Authorization')).toBe('Bearer autopilot-api-key');
  });

  it('POST /transition: Bearer 不正なら 401', async () => {
    const coordinator = createCoordinator();
    const env = createEnv(coordinator.namespace);
    const request = new Request('https://example.com/api/autopilot/transition', {
      method: 'POST',
      headers: { Authorization: 'Bearer wrong-token' },
      body: JSON.stringify({ targetMode: 'NORMAL', reason: 'manual' }),
    });

    const response = await handleAutopilotAPI(request, env, '/api/autopilot/transition');
    const body = await response.json() as { error: string };

    expect(response.status).toBe(401);
    expect(body.error).toBe('Unauthorized');
    expect(coordinator.fetchSpy).not.toHaveBeenCalled();
  });

  it('POST /webhook: HMAC 検証失敗なら 401', async () => {
    const coordinator = createCoordinator();
    const env = createEnv(coordinator.namespace);
    const payload = JSON.stringify({ event: 'heartbeat' });
    const request = new Request('https://example.com/api/autopilot/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Autopilot-Timestamp': String(Date.now()),
        'X-Autopilot-Signature': 'invalid-signature',
      },
      body: payload,
    });

    const response = await handleAutopilotAPI(request, env, '/api/autopilot/webhook');

    expect(response.status).toBe(401);
    expect(coordinator.fetchSpy).not.toHaveBeenCalled();
  });

  it('POST /webhook: HMAC 検証成功で DO /webhook にプロキシ', async () => {
    const coordinator = createCoordinator();
    const env = createEnv(coordinator.namespace);
    const payload = JSON.stringify({ event: 'heartbeat', at: Date.now() });
    const timestamp = String(Date.now());
    const signature = await sign('autopilot-webhook-secret', timestamp, payload);

    const request = new Request('https://example.com/api/autopilot/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Autopilot-Timestamp': timestamp,
        'X-Autopilot-Signature': signature,
      },
      body: payload,
    });

    const response = await handleAutopilotAPI(request, env, '/api/autopilot/webhook');

    expect(response.status).toBe(200);
    expect(coordinator.fetchSpy).toHaveBeenCalledTimes(1);
    const doRequest = coordinator.fetchSpy.mock.calls[0][0] as Request;
    expect(new URL(doRequest.url).pathname).toBe('/webhook');
    expect(doRequest.headers.get('Authorization')).toBe('Bearer autopilot-api-key');
    expect(await doRequest.text()).toBe(payload);
  });

  it('OPTIONS は preflight を返す', async () => {
    const coordinator = createCoordinator();
    const env = createEnv(coordinator.namespace);
    const request = new Request('https://example.com/api/autopilot/status', {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:3000' },
    });

    const response = await handleAutopilotAPI(request, env, '/api/autopilot/status');

    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:3000');
    expect(response.headers.get('Access-Control-Allow-Methods')).toContain('OPTIONS');
    expect(coordinator.fetchSpy).not.toHaveBeenCalled();
  });

  it('DO 応答フォーマットを維持して返す', async () => {
    const coordinator = createCoordinator(async () => new Response(
      JSON.stringify({ success: false, error: { code: 'NOT_FOUND' } }),
      {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      },
    ));
    const env = createEnv(coordinator.namespace);
    const request = new Request('https://example.com/api/autopilot/circuit/failure', {
      method: 'POST',
      headers: { Authorization: 'Bearer autopilot-api-key' },
      body: '{}',
    });

    const response = await handleAutopilotAPI(request, env, '/api/autopilot/circuit/failure');
    const body = await response.json() as { success: boolean; error: { code: string } };

    expect(response.status).toBe(404);
    expect(body).toEqual({ success: false, error: { code: 'NOT_FOUND' } });
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://example.com');
  });
});
