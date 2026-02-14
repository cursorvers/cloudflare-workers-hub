import type { Env } from '../types';
import { safeLog } from '../utils/log-sanitizer';
import { saveGmailRefreshTokenToD1, resolveGmailEncryptionKey } from '../services/gmail-oauth-token-store';

function parseCookies(cookieHeader: string | null): Record<string, string> {
  if (!cookieHeader) return {};
  const out: Record<string, string> = {};
  for (const part of cookieHeader.split(';')) {
    const [rawKey, ...rest] = part.trim().split('=');
    if (!rawKey) continue;
    out[rawKey] = decodeURIComponent(rest.join('=') || '');
  }
  return out;
}

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

const DEFAULT_SCOPES = [
  // Read receipts
  'https://www.googleapis.com/auth/gmail.readonly',
  // Send daily report
  'https://www.googleapis.com/auth/gmail.send',
  // Keep existing Drive backup working (receipt backup JSON)
  'https://www.googleapis.com/auth/drive.file',
].join(' ');

export async function handleGmailOAuthStart(request: Request, env: Env): Promise<Response> {
  if (!env.GMAIL_CLIENT_ID || !env.GMAIL_CLIENT_SECRET) {
    safeLog.error('[Gmail OAuth] Missing client credentials (auth start)', {
      hasClientId: !!env.GMAIL_CLIENT_ID,
      hasClientSecret: !!env.GMAIL_CLIENT_SECRET,
    });
    return new Response('Server not configured', { status: 500 });
  }
  if (!env.DB) {
    safeLog.error('[Gmail OAuth] DB not configured (auth start)');
    return new Response('Server not configured', { status: 500 });
  }
  if (!resolveGmailEncryptionKey(env)) {
    safeLog.error('[Gmail OAuth] Missing encryption key (auth start)', {
      hasGmailEncryptionKey: Boolean((env as any).GMAIL_ENCRYPTION_KEY),
      hasFreeeEncryptionKey: Boolean(env.FREEE_ENCRYPTION_KEY),
    });
    return new Response('Server not configured', { status: 500 });
  }

  const origin = new URL(request.url).origin;
  const redirectUri = (env as any).GMAIL_REDIRECT_URI || `${origin}/api/gmail/callback`;
  const state = crypto.randomUUID();
  const scope = String((env as any).GMAIL_OAUTH_SCOPES || DEFAULT_SCOPES);

  const authUrl = new URL(GOOGLE_AUTH_URL);
  authUrl.search = new URLSearchParams({
    client_id: env.GMAIL_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  }).toString();

  const headers = new Headers({ Location: authUrl.toString() });
  headers.set(
    'Set-Cookie',
    `gmail_oauth_state=${encodeURIComponent(state)}; Max-Age=600; Path=/; HttpOnly; Secure; SameSite=Lax`
  );
  return new Response(null, { status: 302, headers });
}

export async function handleGmailOAuthCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  if (!code) return new Response('Missing authorization code', { status: 400 });

  const state = url.searchParams.get('state');
  const cookieState = parseCookies(request.headers.get('Cookie')).gmail_oauth_state;
  if (cookieState && state && cookieState !== state) {
    safeLog.error('[Gmail OAuth] State mismatch', {
      cookieStatePrefix: cookieState.substring(0, 8),
      statePrefix: state.substring(0, 8),
    });
    return new Response('Invalid OAuth state', { status: 400 });
  }

  if (!env.GMAIL_CLIENT_ID || !env.GMAIL_CLIENT_SECRET) {
    safeLog.error('[Gmail OAuth] Missing required env vars (callback)', {
      hasClientId: !!env.GMAIL_CLIENT_ID,
      hasClientSecret: !!env.GMAIL_CLIENT_SECRET,
    });
    return new Response('Server not configured', { status: 500 });
  }
  if (!env.DB) {
    safeLog.error('[Gmail OAuth] DB not configured (callback)');
    return new Response('Server not configured', { status: 500 });
  }
  if (!resolveGmailEncryptionKey(env)) {
    safeLog.error('[Gmail OAuth] Missing encryption key (callback)', {
      hasGmailEncryptionKey: Boolean((env as any).GMAIL_ENCRYPTION_KEY),
      hasFreeeEncryptionKey: Boolean(env.FREEE_ENCRYPTION_KEY),
    });
    return new Response('Server not configured', { status: 500 });
  }

  const redirectUri = (env as any).GMAIL_REDIRECT_URI || `${new URL(request.url).origin}/api/gmail/callback`;

  safeLog.info('[Gmail OAuth] Exchanging code', {
    redirectUri,
    codePrefix: code.substring(0, 10),
    clientIdPrefix: env.GMAIL_CLIENT_ID.substring(0, 6),
  });

  const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: env.GMAIL_CLIENT_ID,
      client_secret: env.GMAIL_CLIENT_SECRET,
      redirect_uri: redirectUri,
    }).toString(),
  });

  if (!tokenRes.ok) {
    const errText = await tokenRes.text().catch(() => '');
    safeLog.error('[Gmail OAuth] Token exchange failed', {
      status: tokenRes.status,
      error: errText.substring(0, 400),
      redirectUri,
      envRedirectUri: (env as any).GMAIL_REDIRECT_URI,
    });
    return new Response(`Token exchange failed: ${tokenRes.status} ${errText}`, { status: 400 });
  }

  const tokens = (await tokenRes.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    token_type?: string;
  };

  if (!tokens.refresh_token) {
    // Google sometimes omits refresh_token if the user already granted offline access.
    // We force prompt=consent, but still handle the case.
    safeLog.error('[Gmail OAuth] Missing refresh_token in token response', {
      hasAccessToken: Boolean(tokens.access_token),
      expiresIn: tokens.expires_in,
      scope: tokens.scope ? tokens.scope.substring(0, 120) : undefined,
    });

    return new Response(
      [
        'OAuth succeeded but no refresh_token was returned by Google.',
        '',
        'Fix:',
        '- Open /api/gmail/auth again (it uses prompt=consent + access_type=offline).',
        '- If it still does not return refresh_token: revoke app access for this OAuth client in Google Account settings and retry.',
      ].join('\n'),
      {
        status: 400,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Set-Cookie': 'gmail_oauth_state=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax',
        },
      }
    );
  }

  const expiresAtMs =
    typeof tokens.expires_in === 'number' && tokens.expires_in > 60
      ? Date.now() + (tokens.expires_in - 60) * 1000
      : undefined;

  await saveGmailRefreshTokenToD1(env, {
    refreshToken: tokens.refresh_token,
    accessToken: tokens.access_token,
    expiresAtMs,
  });

  safeLog.info('[Gmail OAuth] Tokens stored successfully', {
    scope: tokens.scope ? tokens.scope.substring(0, 120) : undefined,
  });

  return new Response(
    `<!DOCTYPE html>
<html><head><title>Gmail OAuth Success</title></head>
<body style="font-family:system-ui;text-align:center;padding:40px">
  <h1>✅ Gmail認証成功</h1>
  <p>リフレッシュトークンがD1に保存されました（gmail.send含む）。</p>
  <p>このウィンドウを閉じて大丈夫です。</p>
</body></html>`,
    {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Set-Cookie': 'gmail_oauth_state=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax',
      },
    }
  );
}
