import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/log-sanitizer', () => ({
  safeLog: Object.assign(vi.fn(), {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    log: vi.fn(),
  }),
}));

vi.mock('../utils/api-auth', () => ({
  verifyAPIKey: vi.fn(),
}));

vi.mock('../utils/cloudflare-access', () => ({
  authenticateWithAccess: vi.fn(),
  mapAccessUserToInternal: vi.fn(),
}));

vi.mock('../utils/tenant-isolation', () => ({
  getTenantContext: vi.fn(),
  readRequestedTenantId: vi.fn((request: Request) =>
    request.headers.get('X-Tenant-Id') ?? new URL(request.url).searchParams.get('tenant_id')
  ),
}));

import { handleFreeeOAuth } from './freee-oauth';
import { verifyAPIKey } from '../utils/api-auth';
import { authenticateWithAccess, mapAccessUserToInternal } from '../utils/cloudflare-access';
import { getTenantContext } from '../utils/tenant-isolation';

function createEnv() {
  return {
    DB: {
      prepare: vi.fn(() => ({
        bind: vi.fn().mockReturnThis(),
        run: vi.fn().mockResolvedValue({}),
      })),
    },
    FREEE_CLIENT_ID: 'client-id',
    FREEE_CLIENT_SECRET: 'client-secret',
    FREEE_ENCRYPTION_KEY: '12345678901234567890123456789012',
  } as any;
}

describe('handleFreeeOAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    vi.mocked(authenticateWithAccess).mockResolvedValue({ verified: false, error: 'no access' });
    vi.mocked(mapAccessUserToInternal).mockResolvedValue(null);
    vi.mocked(getTenantContext).mockResolvedValue({ tenantId: 'tenant-abc', userId: 'user-1', role: 'admin' } as any);
  });

  it('rejects unauthorized auth initiation', async () => {
    vi.mocked(verifyAPIKey).mockReturnValue(false);

    const response = await handleFreeeOAuth(
      new Request('https://example.com/api/freee/auth'),
      createEnv(),
      '/api/freee/auth'
    );

    expect(response?.status).toBe(401);
  });

  it('starts OAuth when authorized', async () => {
    vi.mocked(verifyAPIKey).mockReturnValue(true);

    const response = await handleFreeeOAuth(
      new Request('https://example.com/api/freee/auth', {
        headers: { 'X-API-Key': 'admin-key', 'X-Tenant-Id': 'tenant-abc' },
      }),
      createEnv(),
      '/api/freee/auth'
    );

    expect(response?.status).toBe(302);
    expect(response?.headers.get('location')).toContain('accounts.secure.freee.co.jp');
    expect(response?.headers.get('set-cookie')).toContain('freee_oauth_state=');
  });

  it('starts OAuth for an authenticated Cloudflare Access operator session', async () => {
    vi.mocked(verifyAPIKey).mockReturnValue(false);
    vi.mocked(authenticateWithAccess).mockResolvedValue({ verified: true, email: 'ops@example.com' });
    vi.mocked(mapAccessUserToInternal).mockResolvedValue({ userId: 'user-1', role: 'operator' });

    const response = await handleFreeeOAuth(
      new Request('https://example.com/api/freee/auth', {
        headers: {
          Cookie: 'CF_Authorization=access-jwt',
          'Cf-Access-Authenticated-User-Email': 'ops@example.com',
          'X-Tenant-Id': 'tenant-abc',
        },
      }),
      createEnv(),
      '/api/freee/auth'
    );

    expect(response?.status).toBe(302);
    expect(response?.headers.get('location')).toContain('accounts.secure.freee.co.jp');
  });

  it('rejects callback without state cookie and clears state cookie', async () => {
    const response = await handleFreeeOAuth(
      new Request('https://example.com/api/freee/callback?code=abc&state=expected'),
      createEnv(),
      '/api/freee/callback'
    );

    expect(response?.status).toBe(400);
    expect(await response?.text()).toContain('Invalid OAuth state');
    expect(response?.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  it('rejects callback with mismatched state and clears state cookie', async () => {
    const response = await handleFreeeOAuth(
      new Request('https://example.com/api/freee/callback?code=abc&state=expected', {
        headers: { Cookie: 'freee_oauth_state=actual' },
      }),
      createEnv(),
      '/api/freee/callback'
    );

    expect(response?.status).toBe(400);
    expect(response?.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  it('fails closed when callback returns multiple companies without explicit company_id', async () => {
    vi.mocked(verifyAPIKey).mockReturnValue(true);
    const env = createEnv();

    const start = await handleFreeeOAuth(
      new Request('https://example.com/api/freee/auth', {
        headers: { 'X-API-Key': 'admin-key', 'X-Tenant-Id': 'tenant-abc' },
      }),
      env,
      '/api/freee/auth'
    );

    const location = start?.headers.get('location') || '';
    const state = new URL(location).searchParams.get('state') || '';
    const cookie = start?.headers.get('set-cookie')?.split(';')[0] || '';

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/public_api/token')) {
        return new Response(JSON.stringify({
          access_token: 'access-token',
          refresh_token: 'refresh-token',
          expires_in: 3600,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.includes('/companies')) {
        return new Response(JSON.stringify({
          companies: [{ id: 111 }, { id: 222 }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('not found', { status: 404 });
    }));

    const callback = await handleFreeeOAuth(
      new Request(`https://example.com/api/freee/callback?code=abc&state=${state}`, {
        headers: { Cookie: cookie },
      }),
      env,
      '/api/freee/callback'
    );

    expect(callback?.status).toBe(400);
    expect(await callback?.text()).toContain('Multiple freee companies found');
  });
});
