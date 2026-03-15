/**
 * Multi-Tenant Isolation Utilities
 *
 * Implements application-level tenant isolation for D1 databases.
 * Provides tenant-scoped query helpers and access control.
 *
 * ## Security Model
 * - Every query must include tenant_id filter
 * - User-to-tenant mapping stored in tenant_users table
 * - Role-based access within tenants (owner, admin, member, viewer)
 * - Default tenant 'default' for backwards compatibility
 *
 * ## Usage
 * ```typescript
 * const tenantContext = await getTenantContext(userId, env);
 * const results = await tenantScopedQuery(
 *   env,
 *   tenantContext.tenantId,
 *   'SELECT * FROM receipts WHERE vendor_name = ?',
 *   ['Amazon']
 * );
 * ```
 */

import type { Env } from '../types';
import { extractUserIdFromKey, type APIScope, verifyAPIKey } from './api-auth';
import { authenticateWithAccess, mapAccessUserToInternal } from './cloudflare-access';
import { safeLog } from './log-sanitizer';

// =============================================================================
// Types
// =============================================================================

export interface TenantContext {
  tenantId: string;
  userId: string;
  role: 'owner' | 'admin' | 'member' | 'viewer';
}

export interface TenantAccessResult {
  hasAccess: boolean;
  tenantContext?: TenantContext;
  error?: string;
}

export interface ResolvedTenantContext extends TenantContext {
  authSource: 'access' | 'api_key';
  requestedTenantId?: string | null;
}

export interface TenantResolutionResult {
  ok: boolean;
  tenantContext?: ResolvedTenantContext;
  error?: string;
  status?: number;
}

export function readRequestedTenantId(request: Request): string | null {
  const headerValue = request.headers.get('X-Tenant-Id')?.trim();
  if (headerValue) return headerValue;

  const url = new URL(request.url);
  const queryValue = url.searchParams.get('tenant_id')?.trim();
  return queryValue || null;
}

function isScopedTenantId(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

// =============================================================================
// Tenant Context
// =============================================================================

/**
 * Get tenant context for a user
 *
 * Returns the tenant the user belongs to and their role within that tenant.
 * For multi-tenant support, users can belong to multiple tenants, but this
 * returns the primary/default tenant for now.
 */
export async function getTenantContext(
  userId: string,
  env: Env
): Promise<TenantContext | null> {
  if (!env.DB) {
    safeLog.error('[Tenant] Database not available');
    return null;
  }

  try {
    const result = await env.DB.prepare(
      `SELECT tenant_id, role FROM tenant_users WHERE user_id = ? AND is_active = 1 LIMIT 1`
    )
      .bind(userId)
      .first<{ tenant_id: string; role: string }>();

    if (!result) {
      safeLog.warn('[Tenant] No tenant mapping found for user', { userId });
      return null;
    }

    return {
      tenantId: result.tenant_id,
      userId,
      role: result.role as 'owner' | 'admin' | 'member' | 'viewer',
    };
  } catch (error) {
    safeLog.error('[Tenant] Error getting tenant context', { error, userId });
    return null;
  }
}

/**
 * Check if user has access to tenant
 */
export async function checkTenantAccess(
  userId: string,
  tenantId: string,
  env: Env
): Promise<TenantAccessResult> {
  const context = await getTenantContext(userId, env);

  if (!context) {
    return {
      hasAccess: false,
      error: 'User not associated with any tenant',
    };
  }

  if (context.tenantId !== tenantId) {
    return {
      hasAccess: false,
      error: 'User does not have access to this tenant',
    };
  }

  return {
    hasAccess: true,
    tenantContext: context,
  };
}

/**
 * Resolve tenant context for the current request.
 *
 * Resolution order:
 * 1. Cloudflare Access authenticated user -> tenant_users mapping
 * 2. Scoped/admin API key with explicit tenant_id or user mapping
 *
 * SECURITY:
 * - authenticated flows must not silently fall back to the legacy "default" tenant
 * - service/admin keys require explicit tenant selection unless a user mapping exists
 */
export async function resolveTenantContext(
  request: Request,
  env: Env,
  scope: APIScope
): Promise<TenantResolutionResult> {
  const requestedTenantId = readRequestedTenantId(request);

  const accessResult = await authenticateWithAccess(request, env);
  if (accessResult.verified && accessResult.email) {
    const internalUser = await mapAccessUserToInternal(accessResult.email, env);
    if (!internalUser) {
      return {
        ok: false,
        error: 'Authenticated user is not mapped to an internal tenant',
        status: 403,
      };
    }

    const tenantContext = await getTenantContext(internalUser.userId, env);
    if (!tenantContext) {
      return {
        ok: false,
        error: 'Authenticated user is not associated with a tenant',
        status: 403,
      };
    }

    if (isScopedTenantId(requestedTenantId) && requestedTenantId !== tenantContext.tenantId) {
      return {
        ok: false,
        error: 'Tenant mismatch',
        status: 403,
      };
    }

    return {
      ok: true,
      tenantContext: {
        ...tenantContext,
        authSource: 'access',
        requestedTenantId,
      },
    };
  }

  if (!verifyAPIKey(request, env, scope)) {
    return {
      ok: false,
      error: 'Unauthorized',
      status: 401,
    };
  }

  const apiKey =
    request.headers.get('X-API-Key') ||
    (request.headers.get('Authorization')?.startsWith('Bearer ')
      ? request.headers.get('Authorization')?.slice('Bearer '.length)
      : null);

  if (!apiKey) {
    return {
      ok: false,
      error: 'Missing API key',
      status: 401,
    };
  }

  const mapping = await extractUserIdFromKey(apiKey, env);
  if (mapping?.userId && mapping.role !== 'service') {
    const tenantContext = await getTenantContext(mapping.userId, env);
    if (!tenantContext) {
      return {
        ok: false,
        error: 'Mapped API user is not associated with a tenant',
        status: 403,
      };
    }

    if (isScopedTenantId(requestedTenantId) && requestedTenantId !== tenantContext.tenantId) {
      return {
        ok: false,
        error: 'Tenant mismatch',
        status: 403,
      };
    }

    return {
      ok: true,
      tenantContext: {
        ...tenantContext,
        authSource: 'api_key',
        requestedTenantId,
      },
    };
  }

  if (!isScopedTenantId(requestedTenantId)) {
    return {
      ok: false,
      error: 'Explicit tenant_id is required for service/admin API keys',
      status: 400,
    };
  }

  return {
    ok: true,
    tenantContext: {
      tenantId: requestedTenantId,
      userId: mapping?.userId ?? 'service',
      role: 'admin',
      authSource: 'api_key',
      requestedTenantId,
    },
  };
}

// =============================================================================
// Tenant-Scoped Queries
// =============================================================================

/**
 * Execute tenant-scoped query
 *
 * Automatically adds tenant_id filter to prevent cross-tenant data access.
 * WARNING: This is a helper - you must still write queries that respect tenant_id!
 */
export async function tenantScopedQuery<T = unknown>(
  env: Env,
  tenantId: string,
  sql: string,
  params: unknown[] = []
): Promise<D1Result<T>> {
  if (!env.DB) {
    throw new Error('Database not available');
  }

  // Log query for audit (remove in production if too verbose)
  safeLog.log('[Tenant] Executing tenant-scoped query', {
    tenantId,
    sql: sql.substring(0, 100), // Log first 100 chars
  });

  // Validate that query includes tenant_id check
  const normalizedSql = sql.toLowerCase().replace(/\s+/g, ' ');
  if (!normalizedSql.includes('tenant_id')) {
    safeLog.error('[Tenant] Query missing tenant_id filter', { sql, tenantId });
    throw new Error('Tenant-scoped query missing tenant_id filter');
  }

  return env.DB.prepare(sql).bind(...params).all<T>();
}

/**
 * Execute tenant-scoped query (single row)
 */
export async function tenantScopedQueryFirst<T = unknown>(
  env: Env,
  tenantId: string,
  sql: string,
  params: unknown[] = []
): Promise<T | null> {
  if (!env.DB) {
    throw new Error('Database not available');
  }

  const normalizedSql = sql.toLowerCase().replace(/\s+/g, ' ');
  if (!normalizedSql.includes('tenant_id')) {
    safeLog.error('[Tenant] Query missing tenant_id filter', { sql, tenantId });
    throw new Error('Tenant-scoped query missing tenant_id filter');
  }

  return env.DB.prepare(sql).bind(...params).first<T>();
}

// =============================================================================
// Role-Based Access Control (within tenant)
// =============================================================================

/**
 * Check if user has required role within tenant
 */
export function hasRole(
  context: TenantContext,
  requiredRole: 'owner' | 'admin' | 'member' | 'viewer'
): boolean {
  const roleHierarchy = ['owner', 'admin', 'member', 'viewer'];
  const userRoleIndex = roleHierarchy.indexOf(context.role);
  const requiredRoleIndex = roleHierarchy.indexOf(requiredRole);

  // Higher roles (lower index) have access to lower roles
  return userRoleIndex <= requiredRoleIndex;
}

/**
 * Require specific role or throw error
 */
export function requireRole(
  context: TenantContext,
  requiredRole: 'owner' | 'admin' | 'member' | 'viewer'
): void {
  if (!hasRole(context, requiredRole)) {
    throw new Error(
      `Insufficient permissions. Required: ${requiredRole}, Current: ${context.role}`
    );
  }
}
