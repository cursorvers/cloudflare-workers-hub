import { SUBJECT_TYPES } from '../types';

import type { AuthResult } from './types';

function freezeAuthResult(result: AuthResult): AuthResult {
  if (result.subject) {
    return Object.freeze({
      ...result,
      subject: Object.freeze({ ...result.subject }),
    });
  }
  return Object.freeze({ ...result });
}

function unauthenticated(reason: string): AuthResult {
  return freezeAuthResult({
    authenticated: false,
    subject: null,
    role: null,
    reason,
  });
}

function authenticated(id: string, reason: string): AuthResult {
  return freezeAuthResult({
    authenticated: true,
    subject: Object.freeze({ id, type: SUBJECT_TYPES.SYSTEM }),
    role: 'operator',
    reason,
  });
}

function parseBearerToken(authHeader: string | null): string | null {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const token = match[1].trim();
  return token.length > 0 ? token : null;
}

function normalizeInput(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Constant-time string comparison to mitigate timing attacks.
 */
export function constantTimeCompare(a: string, b: string): boolean {
  let result = a.length === b.length ? 0 : 1;
  const maxLen = Math.max(a.length, b.length);

  for (let i = 0; i < maxLen; i++) {
    const charA = i < a.length ? a.charCodeAt(i) : 0;
    const charB = i < b.length ? b.charCodeAt(i) : 0;
    result |= charA ^ charB;
  }

  return result === 0;
}

/**
 * Hash token with SHA-256 and return first 16 hex chars.
 */
export async function hashToken(token: string): Promise<string> {
  const encoder = new TextEncoder();
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(token));
  const hex = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');

  return hex.slice(0, 16);
}

/**
 * Pure Bearer auth check using constant-time comparisons.
 */
export function authenticateBearer(
  authHeader: string | null,
  validTokenHashes: readonly string[],
): AuthResult {
  const token = parseBearerToken(authHeader);
  if (!token) return unauthenticated('missing or invalid Bearer token');
  if (validTokenHashes.length === 0) return unauthenticated('no valid tokens configured');

  let matched = false;
  for (const knownHash of validTokenHashes) {
    if (constantTimeCompare(token, knownHash)) {
      matched = true;
    }
  }

  if (!matched) return unauthenticated('invalid Bearer token');
  return authenticated('bearer:token', 'authenticated via Bearer token');
}

/**
 * Pure API key auth check using constant-time comparisons.
 */
export function authenticateAPIKey(
  apiKey: string | null,
  knownKeyHashes: readonly string[],
): AuthResult {
  const normalized = normalizeInput(apiKey);
  if (!normalized) return unauthenticated('missing API key');
  if (knownKeyHashes.length === 0) return unauthenticated('no API keys configured');

  let matched = false;
  for (const knownHash of knownKeyHashes) {
    if (constantTimeCompare(normalized, knownHash)) {
      matched = true;
    }
  }

  if (!matched) return unauthenticated('invalid API key');
  return authenticated('apikey:token', 'authenticated via API key');
}
