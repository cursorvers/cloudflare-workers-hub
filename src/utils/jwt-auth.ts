/**
 * JWT Authentication & RBAC
 *
 * Enhanced authentication system for Cockpit API:
 * - JWT signature verification with jose (Cloudflare Workers compatible)
 * - Token expiration and issuer/audience validation
 * - Refresh token rotation
 * - Role-Based Access Control (RBAC)
 *
 * SECURITY:
 * - Uses RS256 (asymmetric) for production, HS256 for development
 * - Refresh tokens are stored in D1 with automatic expiration
 * - Constant-time comparison for token validation
 */

import { jwtVerify, SignJWT, importSPKI, importPKCS8 } from 'jose';
import type { Env } from '../types';
import { safeLog } from './log-sanitizer';

// =============================================================================
// Types
// =============================================================================

export type UserRole = 'admin' | 'operator' | 'viewer';

export interface JWTPayload {
  sub: string;        // User ID
  role: UserRole;     // User role
  iat: number;        // Issued at
  exp: number;        // Expires at
  iss: string;        // Issuer
  aud: string;        // Audience
  [key: string]: unknown; // Allow additional properties
}

export interface RefreshToken {
  token: string;
  userId: string;
  expiresAt: number;
  createdAt: number;
}

// =============================================================================
// Constants
// =============================================================================

const JWT_ISSUER = 'cloudflare-workers-hub';
const JWT_AUDIENCE = 'cockpit-api';
const ACCESS_TOKEN_EXPIRY = 15 * 60; // 15 minutes
const REFRESH_TOKEN_EXPIRY = 7 * 24 * 60 * 60; // 7 days

// =============================================================================
// JWT Generation & Verification
// =============================================================================

/**
 * Generate access token (short-lived)
 */
export async function generateAccessToken(
  userId: string,
  role: UserRole,
  env: Env
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);

  const payload: JWTPayload = {
    sub: userId,
    role,
    iat: now,
    exp: now + ACCESS_TOKEN_EXPIRY,
    iss: JWT_ISSUER,
    aud: JWT_AUDIENCE,
  };

  // Use RS256 for production (asymmetric), HS256 for development
  const algorithm = env.ENVIRONMENT === 'production' ? 'RS256' : 'HS256';

  if (algorithm === 'RS256') {
    if (!env.JWT_PRIVATE_KEY) {
      throw new Error('JWT_PRIVATE_KEY not configured for production');
    }
    const privateKey = await importPKCS8(env.JWT_PRIVATE_KEY, 'RS256');
    return new SignJWT(payload)
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuedAt(now)
      .setExpirationTime(now + ACCESS_TOKEN_EXPIRY)
      .setIssuer(JWT_ISSUER)
      .setAudience(JWT_AUDIENCE)
      .sign(privateKey);
  } else {
    // Development: symmetric key
    const secret = new TextEncoder().encode(
      env.JWT_SECRET || 'dev-secret-change-in-production'
    );
    return new SignJWT(payload)
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt(now)
      .setExpirationTime(now + ACCESS_TOKEN_EXPIRY)
      .setIssuer(JWT_ISSUER)
      .setAudience(JWT_AUDIENCE)
      .sign(secret);
  }
}

/**
 * Generate refresh token (long-lived) and store in D1
 */
export async function generateRefreshToken(
  userId: string,
  env: Env
): Promise<string> {
  if (!env.DB) {
    throw new Error('Database not available');
  }

  const token = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + REFRESH_TOKEN_EXPIRY;

  await env.DB.prepare(`
    INSERT INTO cockpit_refresh_tokens (token, user_id, expires_at, created_at)
    VALUES (?, ?, ?, ?)
  `).bind(token, userId, expiresAt, now).run();

  safeLog.log('[JWT] Refresh token generated', { userId });

  return token;
}

/**
 * Verify JWT access token
 */
export async function verifyAccessToken(
  token: string,
  env: Env
): Promise<JWTPayload | null> {
  try {
    const algorithm = env.ENVIRONMENT === 'production' ? 'RS256' : 'HS256';

    if (algorithm === 'RS256') {
      if (!env.JWT_PUBLIC_KEY) {
        throw new Error('JWT_PUBLIC_KEY not configured for production');
      }
      const publicKey = await importSPKI(env.JWT_PUBLIC_KEY, 'RS256');
      const { payload } = await jwtVerify(token, publicKey, {
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
      });
      return payload as unknown as JWTPayload;
    } else {
      // Development: symmetric key
      const secret = new TextEncoder().encode(
        env.JWT_SECRET || 'dev-secret-change-in-production'
      );
      const { payload } = await jwtVerify(token, secret, {
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
      });
      return payload as unknown as JWTPayload;
    }
  } catch (error) {
    safeLog.warn('[JWT] Token verification failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Verify refresh token and return associated userId
 */
export async function verifyRefreshToken(
  token: string,
  env: Env
): Promise<string | null> {
  if (!env.DB) {
    safeLog.error('[JWT] Database not available');
    return null;
  }

  try {
    const result = await env.DB.prepare(`
      SELECT user_id, expires_at
      FROM cockpit_refresh_tokens
      WHERE token = ?
    `).bind(token).first<{ user_id: string; expires_at: number }>();

    if (!result) {
      safeLog.warn('[JWT] Refresh token not found');
      return null;
    }

    const now = Math.floor(Date.now() / 1000);
    if (result.expires_at < now) {
      safeLog.warn('[JWT] Refresh token expired', { userId: result.user_id });
      await revokeRefreshToken(token, env);
      return null;
    }

    return result.user_id;
  } catch (error) {
    safeLog.error('[JWT] Refresh token verification failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Revoke refresh token
 */
export async function revokeRefreshToken(token: string, env: Env): Promise<void> {
  if (!env.DB) {
    return;
  }

  await env.DB.prepare(`
    DELETE FROM cockpit_refresh_tokens WHERE token = ?
  `).bind(token).run();

  safeLog.log('[JWT] Refresh token revoked');
}

/**
 * Rotate refresh token (revoke old, issue new)
 */
export async function rotateRefreshToken(
  oldToken: string,
  env: Env
): Promise<string | null> {
  const userId = await verifyRefreshToken(oldToken, env);
  if (!userId) {
    return null;
  }

  // Revoke old token
  await revokeRefreshToken(oldToken, env);

  // Issue new token
  const newToken = await generateRefreshToken(userId, env);
  safeLog.log('[JWT] Refresh token rotated', { userId });

  return newToken;
}

// =============================================================================
// RBAC (Role-Based Access Control)
// =============================================================================

/**
 * Permission matrix for endpoints
 */
const ENDPOINT_PERMISSIONS: Record<string, UserRole[]> = {
  // Read-only endpoints (all roles)
  'GET /api/cockpit/tasks': ['admin', 'operator', 'viewer'],
  'GET /api/cockpit/repos': ['admin', 'operator', 'viewer'],
  'GET /api/cockpit/alerts': ['admin', 'operator', 'viewer'],

  // Write endpoints (admin + operator)
  'POST /api/cockpit/tasks': ['admin', 'operator'],
  'DELETE /api/cockpit/tasks': ['admin'],

  // Alert management (admin + operator)
  'POST /api/cockpit/alerts/ack': ['admin', 'operator'],

  // WebSocket (admin + operator)
  'WS /ws': ['admin', 'operator'],
};

/**
 * Check if user role has permission for endpoint
 */
export function hasPermission(
  method: string,
  path: string,
  role: UserRole
): boolean {
  // Normalize path (remove UUIDs and long hex IDs, but not short path segments like /api)
  // Match: UUIDs (8-4-4-4-12 format) or hex strings with 8+ characters
  const normalizedPath = path.replace(/\/[0-9a-f]{8,}(-[0-9a-f]{4}){0,4}/gi, '/:id');
  const key = `${method} ${normalizedPath}`;

  safeLog.log('[RBAC] Checking permission', { method, path, normalizedPath, key, role });

  const allowedRoles = ENDPOINT_PERMISSIONS[key];
  if (!allowedRoles) {
    // Unknown endpoint - deny by default
    safeLog.warn('[RBAC] Unknown endpoint', { method, path, key });
    return false;
  }

  const hasRole = allowedRoles.includes(role);
  safeLog.log('[RBAC] Permission check result', { key, role, allowedRoles, hasRole });
  return hasRole;
}

/**
 * Extract JWT from request headers
 */
export function extractJWT(request: Request): string | null {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }

  return authHeader.slice(7);
}

/**
 * Get user role from D1 database
 */
export async function getUserRole(userId: string, env: Env): Promise<UserRole | null> {
  if (!env.DB) {
    safeLog.error('[RBAC] Database not available');
    return null;
  }

  try {
    const result = await env.DB.prepare(`
      SELECT role FROM cockpit_users WHERE user_id = ?
    `).bind(userId).first<{ role: UserRole }>();

    return result?.role || null;
  } catch (error) {
    safeLog.error('[RBAC] Failed to get user role', {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Authentication middleware for Cockpit API
 */
export async function authenticateRequest(
  request: Request,
  env: Env
): Promise<{ authenticated: boolean; userId?: string; role?: UserRole; error?: string }> {
  const token = extractJWT(request);
  if (!token) {
    return { authenticated: false, error: 'Missing authorization token' };
  }

  const payload = await verifyAccessToken(token, env);
  if (!payload) {
    return { authenticated: false, error: 'Invalid or expired token' };
  }

  return {
    authenticated: true,
    userId: payload.sub,
    role: payload.role,
  };
}

/**
 * Authorization middleware for Cockpit API
 */
export async function authorizeRequest(
  request: Request,
  userId: string,
  role: UserRole
): Promise<{ authorized: boolean; error?: string }> {
  const url = new URL(request.url);
  const method = request.method;
  const path = url.pathname;

  if (!hasPermission(method, path, role)) {
    safeLog.warn('[RBAC] Permission denied', { method, path, role });
    return {
      authorized: false,
      error: `Insufficient permissions. Required: ${ENDPOINT_PERMISSIONS[`${method} ${path}`]?.join(', ')}`,
    };
  }

  return { authorized: true };
}
