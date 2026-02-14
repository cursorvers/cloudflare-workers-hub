import type { Env } from '../types';
import { safeLog } from '../utils/log-sanitizer';
import { resolveGmailRefreshToken } from '../services/gmail-oauth-token-store';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const TOKENINFO_URL = 'https://oauth2.googleapis.com/tokeninfo';

async function refreshAccessToken(args: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<{ accessToken: string; expiresIn: number | null }> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: args.clientId,
      client_secret: args.clientSecret,
      refresh_token: args.refreshToken,
      grant_type: 'refresh_token',
    }).toString(),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`Gmail token refresh failed: ${response.status} ${errorText}`);
  }

  const data = (await response.json().catch(() => ({}))) as any;
  const accessToken = typeof data.access_token === 'string' ? data.access_token : null;
  const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : null;
  if (!accessToken) throw new Error('Gmail token refresh failed: missing access_token');
  return { accessToken, expiresIn };
}

async function fetchTokenInfo(accessToken: string): Promise<{ scopes: string[]; expiresIn: number | null }> {
  const url = `${TOKENINFO_URL}?` + new URLSearchParams({ access_token: accessToken }).toString();
  const res = await fetch(url, { method: 'GET' });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`tokeninfo failed: ${res.status} ${t}`);
  }
  const data = (await res.json().catch(() => ({}))) as any;
  const scopeRaw = typeof data.scope === 'string' ? data.scope : '';
  const scopes = scopeRaw.split(/\s+/).map((s: string) => s.trim()).filter(Boolean);
  const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : null;
  return { scopes, expiresIn };
}

export async function verifyGmailOAuthPublic(env: Env): Promise<Response> {
  // Throttle public verification to avoid being used as a token refresh oracle.
  if (env.CACHE) {
    try {
      const cached = await env.CACHE.get('gmail:verify-public:last');
      if (cached) {
        return new Response(cached, {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    } catch {
      // ignore
    }
  }

  if (!env.GMAIL_CLIENT_ID || !env.GMAIL_CLIENT_SECRET) {
    return new Response(JSON.stringify({
      ok: false,
      error: 'GMAIL_CLIENT_ID/GMAIL_CLIENT_SECRET not configured',
      remediation: '/api/gmail/auth',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  const refreshToken = await resolveGmailRefreshToken(env);
  if (!refreshToken) {
    return new Response(JSON.stringify({
      ok: false,
      error: 'Gmail refresh token not found (env or D1)',
      remediation: '/api/gmail/auth',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  let accessToken: string;
  try {
    const refreshed = await refreshAccessToken({
      clientId: env.GMAIL_CLIENT_ID,
      clientSecret: env.GMAIL_CLIENT_SECRET,
      refreshToken,
    });
    accessToken = refreshed.accessToken;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const invalidGrant = /invalid_grant/i.test(message);
    return new Response(JSON.stringify({
      ok: false,
      can_refresh: false,
      invalid_grant: invalidGrant,
      error: message.substring(0, 400),
      remediation: '/api/gmail/auth',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  const expected = {
    gmail_readonly: 'https://www.googleapis.com/auth/gmail.readonly',
    gmail_send: 'https://www.googleapis.com/auth/gmail.send',
    drive_file: 'https://www.googleapis.com/auth/drive.file',
  };

  try {
    const info = await fetchTokenInfo(accessToken);
    const scopeSet = new Set(info.scopes);
    const result = {
      ok: true,
      can_refresh: true,
      scopes: {
        gmail_readonly: scopeSet.has(expected.gmail_readonly),
        gmail_send: scopeSet.has(expected.gmail_send),
        drive_file: scopeSet.has(expected.drive_file),
      },
      scope_count: info.scopes.length,
      remediation: null as string | null,
    };

    // If gmail.send is missing, the only fix is re-consent.
    if (!result.scopes.gmail_send) {
      result.ok = false;
      result.remediation = '/api/gmail/auth';
    }

    const body = JSON.stringify(result);

    if (env.CACHE) {
      try {
        await env.CACHE.put('gmail:verify-public:last', body, { expirationTtl: 60 });
      } catch {
        // ignore
      }
    }

    return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    safeLog.warn('[Gmail Verify] tokeninfo failed', { error: message.substring(0, 200) });
    return new Response(JSON.stringify({
      ok: false,
      can_refresh: true,
      error: message.substring(0, 400),
      remediation: null,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
}
