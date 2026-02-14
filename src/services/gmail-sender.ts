/**
 * Gmail Sender (OAuth 2.0 Refresh Token)
 *
 * Used for sending daily receipt reports to the user.
 *
 * Notes:
 * - Requires refresh token scope: https://www.googleapis.com/auth/gmail.send
 * - Fail-soft: callers should catch and continue.
 */

import { z } from 'zod';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1';

const TokenResponseSchema = z.object({
  access_token: z.string(),
  expires_in: z.number(),
  token_type: z.string(),
});

async function refreshAccessToken(args: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<string> {
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

  const data = await response.json();
  const parsed = TokenResponseSchema.parse(data);
  return parsed.access_token;
}

function base64UrlEncode(input: string): string {
  // RFC 4648 base64url (no padding)
  const b64 = btoa(unescape(encodeURIComponent(input)));
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function buildRawTextEmail(args: {
  to: string;
  subject: string;
  bodyText: string;
}): string {
  // Keep it simple. Gmail will add Date/Message-Id.
  const headers = [
    `To: ${args.to}`,
    `Subject: ${args.subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
  ];
  return `${headers.join('\r\n')}\r\n\r\n${args.bodyText}`;
}

export async function sendTextEmailViaGmailOAuth(args: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  to: string;
  subject: string;
  bodyText: string;
}): Promise<{ id?: string }>{
  const accessToken = await refreshAccessToken({
    clientId: args.clientId,
    clientSecret: args.clientSecret,
    refreshToken: args.refreshToken,
  });

  const raw = base64UrlEncode(buildRawTextEmail({
    to: args.to,
    subject: args.subject,
    bodyText: args.bodyText,
  }));

  const response = await fetch(`${GMAIL_API_BASE}/users/me/messages/send`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ raw }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`Gmail send failed: ${response.status} ${errorText}`);
  }

  const data = await response.json().catch(() => ({}));
  if (data && typeof data.id === 'string') {
    return { id: data.id };
  }
  return {};
}
