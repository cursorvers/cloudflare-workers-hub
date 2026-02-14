import type { Env } from '../types';
import { safeLog } from '../utils/log-sanitizer';

const IV_LENGTH = 12;
const KEY_LENGTH = 32;

function atobCompat(base64: string): string {
  if (typeof atob === 'function') return atob(base64);
  // Node fallback for tests/local tooling; workerd provides atob().
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const buf = (globalThis as any).Buffer?.from?.(base64, 'base64');
  if (!buf) throw new Error('Base64 decode failed: atob() and Buffer are unavailable');
  return buf.toString('binary');
}

function btoaCompat(binary: string): string {
  if (typeof btoa === 'function') return btoa(binary);
  // Node fallback for tests/local tooling; workerd provides btoa().
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const buf = (globalThis as any).Buffer?.from?.(binary, 'binary');
  if (!buf) throw new Error('Base64 encode failed: btoa() and Buffer are unavailable');
  return buf.toString('base64');
}

export function resolveGmailEncryptionKey(env: Env): string | null {
  // Prefer dedicated key if present, else reuse FREEE_ENCRYPTION_KEY (already required in prod).
  return (env as any).GMAIL_ENCRYPTION_KEY || env.FREEE_ENCRYPTION_KEY || null;
}

async function encryptToken(token: string, key: string): Promise<string> {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(String(key).padEnd(KEY_LENGTH, '0').slice(0, KEY_LENGTH));
  const cryptoKey = await crypto.subtle.importKey('raw', keyData, { name: 'AES-GCM' }, false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, encoder.encode(token));
  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(encrypted), iv.length);
  return btoaCompat(String.fromCharCode(...combined));
}

async function decryptToken(encrypted: string, key: string): Promise<string> {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(String(key).padEnd(KEY_LENGTH, '0').slice(0, KEY_LENGTH));
  const cryptoKey = await crypto.subtle.importKey('raw', keyData, { name: 'AES-GCM' }, false, ['decrypt']);

  const combined = Uint8Array.from(atobCompat(encrypted), (c) => c.charCodeAt(0));
  if (combined.length <= IV_LENGTH) throw new Error('Invalid encrypted token');
  const iv = combined.slice(0, IV_LENGTH);
  const data = combined.slice(IV_LENGTH);
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, cryptoKey, data);
  return new TextDecoder().decode(decrypted);
}

export async function loadGmailRefreshTokenFromD1(env: Env): Promise<string | null> {
  if (!env.DB) return null;
  const encryptionKey = resolveGmailEncryptionKey(env);
  if (!encryptionKey) return null;
  try {
    const row = (await env.DB.prepare(
      `SELECT encrypted_refresh_token\n       FROM external_oauth_tokens\n       WHERE provider = 'gmail'\n       LIMIT 1`
    ).first()) as { encrypted_refresh_token?: string | null } | null;
    if (!row?.encrypted_refresh_token) return null;
    return await decryptToken(row.encrypted_refresh_token, encryptionKey);
  } catch (error) {
    safeLog.warn('[Gmail OAuth] Failed to load refresh token from D1', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export async function saveGmailRefreshTokenToD1(
  env: Env,
  args: { refreshToken: string; accessToken?: string; expiresAtMs?: number }
): Promise<void> {
  if (!env.DB) throw new Error('DB not configured');
  const encryptionKey = resolveGmailEncryptionKey(env);
  if (!encryptionKey) throw new Error('GMAIL_ENCRYPTION_KEY or FREEE_ENCRYPTION_KEY is required');

  const encryptedRefreshToken = await encryptToken(args.refreshToken, encryptionKey);
  await env.DB.prepare(
    `INSERT INTO external_oauth_tokens (provider, encrypted_refresh_token, access_token, access_token_expires_at_ms, updated_at)\n     VALUES ('gmail', ?, ?, ?, strftime('%s','now'))\n     ON CONFLICT(provider) DO UPDATE SET\n       encrypted_refresh_token=excluded.encrypted_refresh_token,\n       access_token=excluded.access_token,\n       access_token_expires_at_ms=excluded.access_token_expires_at_ms,\n       updated_at=strftime('%s','now')`
  )
    .bind(encryptedRefreshToken, args.accessToken ?? null, args.expiresAtMs ?? null)
    .run();
}

export async function resolveGmailRefreshToken(env: Env): Promise<string | null> {
  const fromD1 = await loadGmailRefreshTokenFromD1(env);
  if (fromD1) return fromD1;
  return env.GMAIL_REFRESH_TOKEN || null;
}
