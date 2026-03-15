import { Env } from '../types';
import { safeLog } from '../utils/log-sanitizer';
import { isFreeeIntegrationEnabled } from '../utils/freee-integration';
import { parseCookies } from '../utils/cookies';
import { verifyAPIKey } from '../utils/api-auth';
import { authenticateWithAccess, mapAccessUserToInternal } from '../utils/cloudflare-access';
import { resolveFreeeBaseUrl } from '../utils/freee-base-url';
import { getTenantContext, readRequestedTenantId } from '../utils/tenant-isolation';

const STATE_COOKIE_NAME = 'freee_oauth_state';
const ALLOWED_ACCESS_ROLES = new Set(['admin', 'operator']);

interface OAuthStatePayload {
  nonce: string;
  tenantId: string;
  userId: string;
  authSource: 'access' | 'api_key';
  requestedCompanyId?: string | null;
  issuedAt: number;
}

function unauthorized(): Response {
  return new Response(JSON.stringify({ error: 'Unauthorized' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  });
}

function clearStateCookie(headers?: HeadersInit): Headers {
  const nextHeaders = new Headers(headers);
  nextHeaders.set(
    'Set-Cookie',
    `${STATE_COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`
  );
  return nextHeaders;
}

function withClearedStateCookie(response: Response): Response {
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: clearStateCookie(response.headers),
  });
}

async function signStatePayload(payload: OAuthStatePayload, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(JSON.stringify(payload)));
  return Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function encodeStateCookie(payload: OAuthStatePayload, secret: string): Promise<string> {
  const signature = await signStatePayload(payload, secret);
  return btoa(JSON.stringify({ payload, signature }));
}

async function decodeStateCookie(rawCookie: string | undefined, secret: string): Promise<OAuthStatePayload | null> {
  if (!rawCookie) return null;

  try {
    const decoded = JSON.parse(atob(rawCookie)) as {
      payload?: OAuthStatePayload;
      signature?: string;
    };
    if (!decoded.payload || !decoded.signature) return null;

    const expectedSignature = await signStatePayload(decoded.payload, secret);
    if (decoded.signature !== expectedSignature) return null;

    const maxAgeMs = 10 * 60 * 1000;
    if (Date.now() - decoded.payload.issuedAt > maxAgeMs) return null;

    return decoded.payload;
  } catch {
    return null;
  }
}

async function resolveOAuthTenantContext(
  request: Request,
  env: Env
): Promise<{ ok: true; tenantId: string; userId: string; authSource: 'access' | 'api_key' } | { ok: false; response: Response }> {
  const accessResult = await authenticateWithAccess(request, env);
  if (accessResult.verified && accessResult.email) {
    const internalUser = await mapAccessUserToInternal(accessResult.email, env);
    if (!internalUser || !ALLOWED_ACCESS_ROLES.has(internalUser.role)) {
      return { ok: false, response: unauthorized() };
    }

    const tenantContext = await getTenantContext(internalUser.userId, env);
    if (!tenantContext) {
      return {
        ok: false,
        response: new Response(JSON.stringify({ error: 'Authenticated user is not associated with a tenant' }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        }),
      };
    }

    const requestedTenantId = readRequestedTenantId(request);
    if (requestedTenantId && requestedTenantId !== tenantContext.tenantId) {
      return {
        ok: false,
        response: new Response(JSON.stringify({ error: 'Tenant mismatch' }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        }),
      };
    }

    return {
      ok: true,
      tenantId: tenantContext.tenantId,
      userId: internalUser.userId,
      authSource: 'access',
    };
  }

  if (!verifyAPIKey(request, env, 'admin')) {
    return { ok: false, response: unauthorized() };
  }

  const requestedTenantId = readRequestedTenantId(request);
  if (!requestedTenantId) {
    return {
      ok: false,
      response: new Response(JSON.stringify({ error: 'Explicit tenant_id is required for admin API keys' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }),
    };
  }

  return {
    ok: true,
    tenantId: requestedTenantId,
    userId: 'service',
    authSource: 'api_key',
  };
}

/**
 * Handle freee OAuth routes (/api/freee/auth, /api/freee/callback).
 * Returns a Response if the path matches, or null to fall through.
 */
export async function handleFreeeOAuth(
  request: Request,
  env: Env,
  path: string,
): Promise<Response | null> {
  if (path === '/api/freee/auth') {
    return handleAuth(request, env);
  }
  if (path === '/api/freee/callback') {
    return handleCallback(request, env);
  }
  return null;
}

/** freee OAuth (manual start): redirects to freee authorize page. */
async function handleAuth(request: Request, env: Env): Promise<Response> {
  if (!isFreeeIntegrationEnabled(env)) {
    return new Response('Not Found', { status: 404 });
  }

  const authContext = await resolveOAuthTenantContext(request, env);
  if (!authContext.ok) return authContext.response;

  if (!env.FREEE_CLIENT_ID || !env.FREEE_CLIENT_SECRET || !env.FREEE_ENCRYPTION_KEY) {
    safeLog.error('[freee OAuth] Missing required env vars (auth start)', {
      hasClientId: !!env.FREEE_CLIENT_ID,
      hasClientSecret: !!env.FREEE_CLIENT_SECRET,
      hasEncryptionKey: !!env.FREEE_ENCRYPTION_KEY,
    });
    return new Response('Server not configured', { status: 500 });
  }

  const origin = new URL(request.url).origin;
  const redirectUri = env.FREEE_REDIRECT_URI || `${origin}/api/freee/callback`;
  const state = crypto.randomUUID();
  const requestedCompanyId = new URL(request.url).searchParams.get('company_id')?.trim() || env.FREEE_COMPANY_ID || null;
  const statePayload: OAuthStatePayload = {
    nonce: state,
    tenantId: authContext.tenantId,
    userId: authContext.userId,
    authSource: authContext.authSource,
    requestedCompanyId,
    issuedAt: Date.now(),
  };
  const encodedStateCookie = await encodeStateCookie(statePayload, env.FREEE_ENCRYPTION_KEY);

  const authUrl = new URL('https://accounts.secure.freee.co.jp/public_api/authorize');
  authUrl.search = new URLSearchParams({
    response_type: 'code',
    client_id: env.FREEE_CLIENT_ID,
    redirect_uri: redirectUri,
    // freee requires explicit scopes for API access. Keep it broad enough for receipts + deal automation.
    scope: 'read write',
    state,
  }).toString();

  const headers = new Headers({ Location: authUrl.toString() });
  headers.set(
    'Set-Cookie',
    `${STATE_COOKIE_NAME}=${encodeURIComponent(encodedStateCookie)}; Max-Age=600; Path=/; HttpOnly; Secure; SameSite=Lax`
  );
  return new Response(null, { status: 302, headers });
}

/** freee OAuth Callback endpoint */
async function handleCallback(request: Request, env: Env): Promise<Response> {
  if (!isFreeeIntegrationEnabled(env)) {
    return withClearedStateCookie(new Response('Not Found', { status: 404 }));
  }

  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  if (!code) {
    return withClearedStateCookie(
      new Response('Missing authorization code', { status: 400 })
    );
  }

  const state = url.searchParams.get('state');
  const cookieState = parseCookies(request.headers.get('Cookie'))[STATE_COOKIE_NAME];
  const statePayload = await decodeStateCookie(cookieState, env.FREEE_ENCRYPTION_KEY || '');
  if (!state || !statePayload || state !== statePayload.nonce) {
    safeLog.error('[freee OAuth] State mismatch', {
      hasState: !!state,
      hasCookieState: !!statePayload,
      cookieStatePrefix: cookieState?.substring(0, 8),
      statePrefix: state?.substring(0, 8),
    });
    return withClearedStateCookie(
      new Response('Invalid OAuth state', { status: 400 })
    );
  }

  if (!env.FREEE_CLIENT_ID || !env.FREEE_CLIENT_SECRET || !env.FREEE_ENCRYPTION_KEY) {
    safeLog.error('[freee OAuth] Missing required env vars', {
      hasClientId: !!env.FREEE_CLIENT_ID,
      hasClientSecret: !!env.FREEE_CLIENT_SECRET,
      hasEncryptionKey: !!env.FREEE_ENCRYPTION_KEY,
    });
    return withClearedStateCookie(
      new Response('Server not configured', { status: 500 })
    );
  }
  if (!env.DB) {
    safeLog.error('[freee OAuth] DB not configured');
    return withClearedStateCookie(
      new Response('Server not configured', { status: 500 })
    );
  }

  try {
    // Prefer configured redirect URI (stable across script/env hostnames).
    // Fallback to same-origin callback for development/staging.
    const redirectUri = env.FREEE_REDIRECT_URI || `${new URL(request.url).origin}/api/freee/callback`;

    // Primary: send client_id/client_secret in the form body (common OAuth pattern).
    // Fallback: some OAuth servers require client authentication via HTTP Basic and
    // may reject (or mis-handle) duplicated credentials in both header + body.
    const paramsWithClientSecret = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: env.FREEE_CLIENT_ID,
      client_secret: env.FREEE_CLIENT_SECRET,
      code: code,
      redirect_uri: redirectUri,
    });

    safeLog.log('[freee OAuth] Exchanging code', {
      redirectUri,
      codePrefix: code.substring(0, 10),
      clientIdPrefix: env.FREEE_CLIENT_ID?.substring(0, 6),
    });

    const tokenUrl = 'https://accounts.secure.freee.co.jp/public_api/token';
    const basicAuth = btoa(`${env.FREEE_CLIENT_ID}:${env.FREEE_CLIENT_SECRET}`);

    // Exchange code for tokens. Some OAuth servers require client auth via Basic;
    // we try without and then retry with Basic to reduce misconfiguration/debug time.
    const tryExchange = async (useBasic: boolean): Promise<Response> => {
      const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' };
      if (useBasic) headers.Authorization = `Basic ${basicAuth}`;
      const body = useBasic
        ? new URLSearchParams({
            grant_type: 'authorization_code',
            code: code,
            redirect_uri: redirectUri,
          })
        : paramsWithClientSecret;
      return fetch(tokenUrl, { method: 'POST', headers, body });
    };

    let tokenResponse = await tryExchange(false);
    const fallback: { attempted: boolean; status?: number; body?: string } = { attempted: false };

    if (!tokenResponse.ok) {
      const primaryError = await tokenResponse.text();
      safeLog.error('[freee OAuth] Token exchange failed (primary)', {
        status: tokenResponse.status,
        error: primaryError,
        redirectUri,
        envRedirectUri: env.FREEE_REDIRECT_URI,
      });

      fallback.attempted = true;
      const tokenResponse2 = await tryExchange(true);
      if (tokenResponse2.ok) {
        tokenResponse = tokenResponse2;
      } else {
        const fallbackError = await tokenResponse2.text();
        fallback.status = tokenResponse2.status;
        fallback.body = fallbackError;
        safeLog.error('[freee OAuth] Token exchange failed (basic auth fallback)', {
          status: tokenResponse2.status,
          error: fallbackError,
          redirectUri,
          envRedirectUri: env.FREEE_REDIRECT_URI,
        });

        // Include non-secret diagnostics to reduce guesswork when debugging invalid_grant.
        const hint =
          primaryError.includes('invalid_grant') || fallbackError.includes('invalid_grant')
            ? 'Hint: authorization codes are short-lived and one-time-use. Restart from /api/freee/auth (do not refresh /callback). Also verify FREEE_CLIENT_SECRET and that FREEE_REDIRECT_URI exactly matches the redirect URI registered in freee.'
            : 'Hint: verify freee app settings and Worker secrets.';

        return withClearedStateCookie(new Response(
          [
            `Token exchange failed (primary): ${primaryError}`,
            `Token exchange failed (basic auth): ${fallbackError}`,
            '',
            `redirect_uri_used: ${redirectUri}`,
            `env.FREEE_REDIRECT_URI: ${env.FREEE_REDIRECT_URI || '(unset)'}`,
            hint,
          ].join('\n'),
          { status: 400 }
        ));
      }
    }

    const tokens = await tokenResponse.json() as { access_token: string; refresh_token: string; expires_in: number };

    // Optionally resolve company_id from freee API so the Worker can operate without
    // requiring FREEE_COMPANY_ID as a secret (we persist this to D1 when possible).
    let companyId: string | null = null;
    try {
      const companiesRes = await fetch(`${resolveFreeeBaseUrl(env)}/companies`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });
      if (companiesRes.ok) {
        const companiesPayload = await companiesRes.json() as { companies?: Array<{ id: number }> };
        const companies = Array.isArray(companiesPayload.companies) ? companiesPayload.companies : [];
        if (companies.length > 0) {
          const requestedCompanyId = statePayload.requestedCompanyId?.trim() || null;
          if (requestedCompanyId) {
            const match = companies.find((company) => String(company.id) === requestedCompanyId);
            if (!match) {
              return withClearedStateCookie(
                new Response(`Requested company_id ${requestedCompanyId} was not returned by freee`, { status: 400 })
              );
            }
            companyId = String(match.id);
          } else if (companies.length === 1) {
            companyId = String(companies[0].id);
          } else {
            safeLog.error('[freee OAuth] Multiple companies returned without explicit company selection', {
              count: companies.length,
            });
            return withClearedStateCookie(
              new Response('Multiple freee companies found. Restart auth with ?company_id=<freee company id>.', {
                status: 400,
              })
            );
          }
        }
      } else {
        safeLog.warn('[freee OAuth] Failed to fetch companies (continuing)', { status: companiesRes.status });
      }
    } catch (e) {
      safeLog.warn('[freee OAuth] Error fetching companies (continuing)', { error: String(e) });
    }

    // Encrypt refresh token with AES-GCM
    const encoder = new TextEncoder();
    const keyData = encoder.encode(env.FREEE_ENCRYPTION_KEY.padEnd(32, '0').slice(0, 32));
    const cryptoKey = await crypto.subtle.importKey('raw', keyData, { name: 'AES-GCM' }, false, ['encrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, encoder.encode(tokens.refresh_token));
    const combined = new Uint8Array(iv.length + encrypted.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(encrypted), iv.length);
    const encryptedRefreshToken = btoa(String.fromCharCode(...combined));

    // Store tokens in D1 (preferred). Fallback to KV if migrations are not applied yet.
    const expiresAtMs = Date.now() + (tokens.expires_in - 60) * 1000;
    try {
      await env.DB.prepare(
        `INSERT INTO external_oauth_tokens (
          tenant_id,
          provider,
          company_id,
          encrypted_refresh_token,
          access_token,
          access_token_expires_at_ms,
          updated_at
        )
        VALUES (?, 'freee', ?, ?, ?, ?, strftime('%s','now'))
        ON CONFLICT(tenant_id, provider, company_id) DO UPDATE SET
          encrypted_refresh_token = excluded.encrypted_refresh_token,
          access_token = excluded.access_token,
          access_token_expires_at_ms = excluded.access_token_expires_at_ms,
          updated_at = strftime('%s','now')`
      ).bind(
        statePayload.tenantId,
        companyId ?? '',
        encryptedRefreshToken,
        tokens.access_token,
        expiresAtMs
      ).run();
    } catch (error) {
      safeLog.error('[freee OAuth] Failed to persist tokens to D1', { error: String(error) });
      return withClearedStateCookie(new Response('OAuth processing failed. Check server logs for details.', { status: 500 }));
    }

    safeLog.log('[freee OAuth] Tokens stored successfully');

    return withClearedStateCookie(new Response(`
      <!DOCTYPE html>
      <html><head><title>freee OAuth Success</title></head>
      <body style="font-family:system-ui;text-align:center;padding:40px">
        <h1>✅ freee認証成功</h1>
        <p>アクセストークンとリフレッシュトークンが保存されました。</p>
        <p>このウィンドウを閉じて大丈夫です。</p>
      </body></html>
    `, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
      },
    }));
  } catch (error) {
    safeLog.error('[freee OAuth] Error', { error: String(error) });
    return withClearedStateCookie(
      new Response('OAuth processing failed. Check server logs for details.', { status: 500 })
    );
  }
}
