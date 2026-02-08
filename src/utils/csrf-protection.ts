/**
 * CSRF Protection Utilities
 *
 * Implements Origin and Referer validation to prevent Cross-Site Request Forgery attacks.
 * Works in conjunction with Bearer token authentication for defense-in-depth.
 *
 * ## Security Model
 * - Origin header validation (primary)
 * - Referer header validation (fallback)
 * - Allowlist-based approach (explicit allow)
 * - Configurable via environment variables
 */

import type { Env } from '../types';
import { safeLog } from './log-sanitizer';

// =============================================================================
// Types
// =============================================================================

export interface OriginValidationResult {
  valid: boolean;
  error?: string;
  origin?: string;
  method?: 'origin' | 'referer';
}

// =============================================================================
// Origin Validation
// =============================================================================

/**
 * Get allowed origins from environment
 */
function getAllowedOrigins(env: Env): string[] {
  const origins: string[] = [];

  // Production domains (multiple Workers scripts can exist via Wrangler envs).
  // Keep this list explicit to avoid accidentally trusting arbitrary origins.
  const workersDomains = [
    'orchestrator-hub.masa-stage1.workers.dev',
    'orchestrator-hub-production.masa-stage1.workers.dev',
    'orchestrator-hub-canary.masa-stage1.workers.dev',
  ];
  workersDomains.forEach((d) => origins.push(`https://${d}`));

  // Development origins
  if (env.ENVIRONMENT === 'development' && env.ALLOW_DEV_ORIGINS) {
    const devOrigins = env.ALLOW_DEV_ORIGINS.split(',')
      .map((o) => o.trim())
      .filter((o) => o.length > 0);

    devOrigins.forEach((origin) => {
      // Add both http and https for localhost
      if (origin.includes('localhost')) {
        origins.push(`http://${origin}`);
        origins.push(`https://${origin}`);
      } else {
        origins.push(`https://${origin}`);
      }
    });
  }

  return origins;
}

/**
 * Extract origin from Referer header
 */
function extractOriginFromReferer(referer: string): string | null {
  try {
    const url = new URL(referer);
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

/**
 * Validate request origin against allowlist
 *
 * Checks Origin header first, falls back to Referer header.
 * Returns valid=false if neither header is present or origin is not allowed.
 */
export function validateOrigin(
  request: Request,
  env: Env
): OriginValidationResult {
  const allowedOrigins = getAllowedOrigins(env);

  // GET/HEAD requests are generally safe from CSRF (read-only)
  // Still validate to log suspicious activity
  const method = request.method.toUpperCase();
  const requiresValidation = ['POST', 'PUT', 'DELETE', 'PATCH'].includes(method);

  // Check Origin header (primary)
  const origin = request.headers.get('Origin');
  if (origin) {
    if (allowedOrigins.includes(origin)) {
      safeLog.log('[CSRF] Origin validated', { origin, method: 'origin' });
      return { valid: true, origin, method: 'origin' };
    } else {
      safeLog.warn('[CSRF] Origin rejected', { origin, allowedOrigins });
      return {
        valid: false,
        error: `Origin '${origin}' not allowed`,
        origin,
      };
    }
  }

  // Fallback to Referer header
  const referer = request.headers.get('Referer');
  if (referer) {
    const refererOrigin = extractOriginFromReferer(referer);
    if (refererOrigin && allowedOrigins.includes(refererOrigin)) {
      safeLog.log('[CSRF] Referer validated', { referer, method: 'referer' });
      return { valid: true, origin: refererOrigin, method: 'referer' };
    } else {
      safeLog.warn('[CSRF] Referer rejected', { referer, allowedOrigins });
      return {
        valid: false,
        error: `Referer origin '${refererOrigin}' not allowed`,
        origin: refererOrigin || undefined,
      };
    }
  }

  // No Origin or Referer header
  if (requiresValidation) {
    safeLog.warn('[CSRF] Missing Origin/Referer for state-changing request', {
      method,
      url: request.url,
    });
    return {
      valid: false,
      error: 'Missing Origin or Referer header for state-changing request',
    };
  }

  // GET/HEAD without headers - allow but log
  safeLog.log('[CSRF] No Origin/Referer for read-only request', { method });
  return { valid: true };
}

/**
 * Create CSRF error response
 */
export function createCSRFErrorResponse(result: OriginValidationResult): Response {
  return new Response(
    JSON.stringify({
      error: 'CSRF validation failed',
      message: result.error || 'Invalid origin',
    }),
    {
      status: 403,
      headers: {
        'Content-Type': 'application/json',
        'X-Content-Type-Options': 'nosniff',
      },
    }
  );
}
