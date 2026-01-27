/**
 * API Authentication Utilities
 *
 * Provides functions for API key verification and user authorization:
 * - Constant-time API key comparison to prevent timing attacks
 * - API key hashing for secure storage
 * - User ID extraction from API keys
 * - Authorization checks to prevent IDOR vulnerabilities
 *
 * SECURITY: All comparison functions use constant-time algorithms to prevent timing attacks.
 * Service role keys bypass per-user checks for system daemons that process tasks for all users.
 */

import { Env } from '../types';
import { safeLog, maskUserId } from './log-sanitizer';

export type APIScope = 'queue' | 'memory' | 'admin';

export interface APIKeyMapping {
  userId: string;
  role?: 'service' | 'user';
}

/**
 * Verify API Key with constant-time comparison
 */
export function verifyAPIKey(request: Request, env: Env, scope: APIScope = 'queue'): boolean {
  // Get scoped key or fall back to legacy ASSISTANT_API_KEY
  const scopedKeys: Record<APIScope, string | undefined> = {
    queue: env.QUEUE_API_KEY || env.ASSISTANT_API_KEY,
    memory: env.MEMORY_API_KEY || env.ASSISTANT_API_KEY,
    admin: env.ADMIN_API_KEY, // No fallback for admin - explicit key required
  };

  const expectedKey = scopedKeys[scope];

  // SECURITY: Fail-closed - API Key is mandatory
  if (!expectedKey) {
    safeLog.error(`[API] ${scope.toUpperCase()}_API_KEY not configured - access denied`);
    return false;
  }

  const apiKey = request.headers.get('X-API-Key');
  if (!apiKey) {
    safeLog.warn(`[API] Missing API key for scope: ${scope}`);
    return false;
  }

  // Constant-time comparison to prevent timing attacks
  // Always execute full comparison regardless of length to prevent timing leaks
  let result = apiKey.length === expectedKey.length ? 0 : 1;
  const maxLen = Math.max(apiKey.length, expectedKey.length);
  for (let i = 0; i < maxLen; i++) {
    const a = i < apiKey.length ? apiKey.charCodeAt(i) : 0;
    const b = i < expectedKey.length ? expectedKey.charCodeAt(i) : 0;
    result |= a ^ b;
  }

  if (result !== 0) {
    safeLog.warn(`[API] Invalid API key for scope: ${scope}`);
    return false;
  }

  return true;
}

/**
 * Hash API key using SHA-256 and return first 16 characters
 * Used for storing API key -> userId mappings without exposing full keys
 */
export async function hashAPIKey(apiKey: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(apiKey);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  return hashHex.substring(0, 16);
}

/**
 * Extract userId and role from API key by looking up KV mapping
 * Returns null if mapping doesn't exist
 *
 * SECURITY: This prevents IDOR by deriving userId from cryptographic API key
 * instead of trusting URL parameters.
 * Service role keys (role: 'service') bypass per-user checks for system daemons.
 */
export async function extractUserIdFromKey(apiKey: string, env: Env): Promise<APIKeyMapping | null> {
  if (!env.CACHE) {
    safeLog.error('[API] CACHE KV namespace not available');
    return null;
  }

  const keyHash = await hashAPIKey(apiKey);
  const mappingKey = `apikey:mapping:${keyHash}`;

  const mapping = await env.CACHE.get(mappingKey, 'json') as APIKeyMapping | null;

  if (!mapping || !mapping.userId) {
    safeLog.warn('[API] No userId mapping found for API key', { keyHash: keyHash.substring(0, 8) });
    return null;
  }

  return mapping;
}

/**
 * Verify that the requested userId matches the userId derived from API key
 * Returns true if authorized, false otherwise
 *
 * SECURITY: Prevents IDOR by ensuring users can only access their own data.
 * Service role keys (role: 'service') bypass per-user checks for system daemons
 * like assistant-daemon.js that process tasks for all users.
 */
export async function authorizeUserAccess(
  request: Request,
  requestedUserId: string,
  env: Env
): Promise<boolean> {
  const apiKey = request.headers.get('X-API-Key');
  if (!apiKey) {
    safeLog.warn('[API] Missing API key for authorization');
    return false;
  }

  const mapping = await extractUserIdFromKey(apiKey, env);
  if (!mapping) {
    safeLog.warn('[API] Failed to derive userId from API key');
    return false;
  }

  // Service role: bypass per-user check (for system daemons)
  if (mapping.role === 'service') {
    safeLog.log('[API:audit] Service role access', {
      targetUserId: maskUserId(requestedUserId),
      serviceId: maskUserId(mapping.userId),
      endpoint: new URL(request.url).pathname,
    });
    return true;
  }

  const derivedUserId = mapping.userId;

  // Constant-time comparison to prevent timing attacks
  // Always execute full comparison regardless of length to prevent timing leaks
  let result = derivedUserId.length === requestedUserId.length ? 0 : 1;
  const maxLen = Math.max(derivedUserId.length, requestedUserId.length);
  for (let i = 0; i < maxLen; i++) {
    const a = i < derivedUserId.length ? derivedUserId.charCodeAt(i) : 0;
    const b = i < requestedUserId.length ? requestedUserId.charCodeAt(i) : 0;
    result |= a ^ b;
  }

  const authorized = result === 0;

  if (!authorized) {
    safeLog.warn('[API] Authorization failed: userId mismatch', {
      requested: maskUserId(requestedUserId),
      derived: maskUserId(derivedUserId),
    });
  }

  return authorized;
}
