/**
 * Cloudflare Access JWT Verification
 *
 * Verifies JWT tokens from Cloudflare Access (Zero Trust) authentication.
 * Used to authenticate requests that have passed through Cloudflare Access.
 *
 * Flow:
 * 1. User authenticates via Google SSO through Cloudflare Access
 * 2. Access adds Cf-Access-Jwt-Assertion header with signed JWT
 * 3. This module verifies the JWT signature using Access's public keys
 *
 * SECURITY:
 * - Public keys are fetched from Cloudflare's certs endpoint
 * - Keys are cached in KV to reduce latency
 * - Validates issuer, audience, and expiration
 */

import { jwtVerify, createRemoteJWKSet } from 'jose';
import type { Env } from '../types';
import { safeLog } from './log-sanitizer';

// =============================================================================
// Types
// =============================================================================

export interface AccessJWTPayload {
  aud: string[];           // Audience (Application AUD tag)
  email: string;           // User's email from IdP
  exp: number;             // Expiration timestamp
  iat: number;             // Issued at timestamp
  nbf?: number;            // Not before timestamp
  iss: string;             // Issuer (Cloudflare Access team domain)
  type: string;            // Token type (usually "app")
  identity_nonce?: string; // Nonce for identity verification
  sub: string;             // Subject (user ID)
  country?: string;        // User's country (from Cloudflare)
}

export interface AccessVerificationResult {
  verified: boolean;
  payload?: AccessJWTPayload;
  email?: string;
  error?: string;
}

// =============================================================================
// Constants
// =============================================================================

const CACHE_KEY_PREFIX = 'cf-access-certs:';
const CACHE_TTL_SECONDS = 3600; // 1 hour

// =============================================================================
// Public Key Fetching & Caching
// =============================================================================

/**
 * Get Cloudflare Access certs endpoint URL
 */
function getCertsUrl(teamDomain: string): string {
  // Team domain can be either:
  // - Full URL: https://masa-stage1.cloudflareaccess.com
  // - Just the team name: masa-stage1
  if (teamDomain.includes('://')) {
    return `${teamDomain}/cdn-cgi/access/certs`;
  }
  return `https://${teamDomain}.cloudflareaccess.com/cdn-cgi/access/certs`;
}

/**
 * Fetch public keys from Cloudflare Access
 * Keys are cached in KV for performance
 */
async function getPublicKeys(
  teamDomain: string,
  env: Env
): Promise<string | null> {
  const cacheKey = `${CACHE_KEY_PREFIX}${teamDomain}`;

  // Try cache first
  if (env.CACHE) {
    try {
      const cached = await env.CACHE.get(cacheKey);
      if (cached) {
        safeLog.debug('[Access] Using cached public keys', { teamDomain });
        return cached;
      }
    } catch (error) {
      safeLog.warn('[Access] Cache read failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Fetch from Cloudflare
  const certsUrl = getCertsUrl(teamDomain);
  safeLog.log('[Access] Fetching public keys', { certsUrl });

  try {
    const response = await fetch(certsUrl);
    if (!response.ok) {
      safeLog.error('[Access] Failed to fetch certs', {
        status: response.status,
        statusText: response.statusText,
      });
      return null;
    }

    const certs = await response.text();

    // Cache the response
    if (env.CACHE) {
      try {
        await env.CACHE.put(cacheKey, certs, {
          expirationTtl: CACHE_TTL_SECONDS,
        });
        safeLog.log('[Access] Public keys cached', { teamDomain });
      } catch (error) {
        safeLog.warn('[Access] Cache write failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return certs;
  } catch (error) {
    safeLog.error('[Access] Network error fetching certs', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

// =============================================================================
// JWT Verification
// =============================================================================

/**
 * Verify Cloudflare Access JWT
 *
 * @param token - The JWT from Cf-Access-Jwt-Assertion header
 * @param teamDomain - Cloudflare Access team domain (e.g., "masa-stage1")
 * @param applicationAud - Application AUD tag from Access dashboard
 * @param env - Environment bindings
 */
export async function verifyAccessJWT(
  token: string,
  teamDomain: string,
  applicationAud: string,
  env: Env
): Promise<AccessVerificationResult> {
  try {
    // Use JWKS endpoint for verification
    const certsUrl = getCertsUrl(teamDomain);
    const JWKS = createRemoteJWKSet(new URL(certsUrl));

    // Expected issuer URL
    const expectedIssuer = teamDomain.includes('://')
      ? teamDomain
      : `https://${teamDomain}.cloudflareaccess.com`;

    // Verify the JWT
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: expectedIssuer,
      audience: applicationAud,
    });

    const accessPayload = payload as unknown as AccessJWTPayload;

    safeLog.log('[Access] JWT verified successfully', {
      email: accessPayload.email,
      sub: accessPayload.sub,
    });

    return {
      verified: true,
      payload: accessPayload,
      email: accessPayload.email,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    safeLog.warn('[Access] JWT verification failed', { error: errorMessage });

    return {
      verified: false,
      error: errorMessage,
    };
  }
}

/**
 * Extract Access JWT from request headers or cookies
 *
 * Cloudflare Access provides JWT via:
 * - Cf-Access-Jwt-Assertion header (for API calls)
 * - CF_Authorization cookie (for browser/PWA requests)
 */
export function extractAccessJWT(request: Request): string | null {
  // Try header first (API calls, proxied requests)
  const headerToken = request.headers.get('Cf-Access-Jwt-Assertion');
  if (headerToken) {
    return headerToken;
  }

  // Try cookie (browser/PWA requests)
  const cookieHeader = request.headers.get('Cookie');
  if (cookieHeader) {
    const cookies = cookieHeader.split(';').map(c => c.trim());
    for (const cookie of cookies) {
      if (cookie.startsWith('CF_Authorization=')) {
        return cookie.slice('CF_Authorization='.length);
      }
    }
  }

  return null;
}

/**
 * Extract authenticated user email from request headers
 * This is a convenience header added by Cloudflare Access
 */
export function extractAccessEmail(request: Request): string | null {
  return request.headers.get('Cf-Access-Authenticated-User-Email');
}

// =============================================================================
// Middleware
// =============================================================================

/**
 * Cloudflare Access authentication middleware
 *
 * Usage:
 * ```typescript
 * const accessResult = await authenticateWithAccess(request, env);
 * if (!accessResult.verified) {
 *   // Fall back to existing JWT auth or return 401
 * }
 * ```
 */
export async function authenticateWithAccess(
  request: Request,
  env: Env
): Promise<AccessVerificationResult> {
  // Check if Access is configured
  if (!env.CF_ACCESS_TEAM || !env.CF_ACCESS_AUD) {
    safeLog.debug('[Access] Access not configured, skipping');
    return {
      verified: false,
      error: 'Access not configured',
    };
  }

  // Extract JWT from header
  const token = extractAccessJWT(request);
  if (!token) {
    return {
      verified: false,
      error: 'No Access JWT found',
    };
  }

  // Verify the JWT
  return verifyAccessJWT(token, env.CF_ACCESS_TEAM, env.CF_ACCESS_AUD, env);
}

/**
 * Map Access email to internal user (for RBAC integration)
 *
 * This function looks up the user by email and returns their internal user ID
 * and role for integration with the existing RBAC system.
 */
export async function mapAccessUserToInternal(
  email: string,
  env: Env
): Promise<{ userId: string; role: string } | null> {
  if (!env.DB) {
    safeLog.error('[Access] Database not available for user lookup');
    return null;
  }

  try {
    const user = await env.DB.prepare(`
      SELECT user_id, role FROM cockpit_users WHERE email = ? AND is_active = 1
    `)
      .bind(email)
      .first<{ user_id: string; role: string }>();

    if (!user) {
      safeLog.warn('[Access] No active user found for email', { email });
      return null;
    }

    return {
      userId: user.user_id,
      role: user.role,
    };
  } catch (error) {
    safeLog.error('[Access] User lookup failed', {
      email,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
