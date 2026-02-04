/**
 * Authentication & Authorization for Server Actions
 *
 * Simple auth check for Phase 1. Will be expanded in Phase 3 with proper RBAC.
 */

import { headers } from 'next/headers';

export interface AuthContext {
  userId?: string;
  role?: 'admin' | 'user' | 'viewer';
}

/**
 * Get authenticated user context from request headers
 *
 * Phase 1: Simple API key check (development mode)
 * Phase 3: JWT/session-based auth
 */
export async function getAuthContext(): Promise<AuthContext | null> {
  // Phase 1: Development mode - auto-authenticate
  // In production, this should check proper session/JWT
  if (process.env.NODE_ENV === 'development') {
    return {
      userId: 'dev-user',
      role: 'admin',
    };
  }

  const headersList = await headers();
  const apiKey = headersList.get('x-api-key');

  // Phase 1: Simple API key validation
  // TODO Phase 3: Replace with proper session/JWT validation
  if (!apiKey || apiKey !== process.env.API_KEY) {
    return null;
  }

  return {
    userId: 'admin', // Placeholder
    role: 'admin',
  };
}

/**
 * Require authentication for Server Action
 * Throws error if unauthorized
 */
export async function requireAuth(): Promise<AuthContext> {
  const auth = await getAuthContext();
  if (!auth) {
    throw new Error('Unauthorized: Valid API key required');
  }
  return auth;
}

/**
 * Require specific role
 */
export async function requireRole(
  role: AuthContext['role']
): Promise<AuthContext> {
  const auth = await requireAuth();
  if (auth.role !== role && auth.role !== 'admin') {
    throw new Error(`Forbidden: ${role} role required`);
  }
  return auth;
}

/**
 * Check if user has permission for action
 * Phase 3: Fine-grained permission checks
 */
export async function hasPermission(
  action: 'read' | 'create' | 'update' | 'delete',
  resource: 'task' | 'repo' | 'alert'
): Promise<boolean> {
  const auth = await getAuthContext();
  if (!auth) return false;

  // Admin has all permissions
  if (auth.role === 'admin') return true;

  // Permission matrix
  const permissions: Record<string, Record<string, string[]>> = {
    task: {
      read: ['admin', 'user', 'viewer'],
      create: ['admin', 'user'],
      update: ['admin', 'user'],
      delete: ['admin'],
    },
    repo: {
      read: ['admin', 'user', 'viewer'],
      create: ['admin'],
      update: ['admin'],
      delete: ['admin'],
    },
    alert: {
      read: ['admin', 'user', 'viewer'],
      create: ['admin', 'user'],
      update: ['admin', 'user'],
      delete: ['admin'],
    },
  };

  const allowedRoles = permissions[resource]?.[action] || [];
  return allowedRoles.includes(auth.role || '');
}

/**
 * Require permission for action
 * Throws error if user lacks permission
 */
export async function requirePermission(
  action: 'read' | 'create' | 'update' | 'delete',
  resource: 'task' | 'repo' | 'alert'
): Promise<AuthContext> {
  const auth = await requireAuth();
  const allowed = await hasPermission(action, resource);

  if (!allowed) {
    throw new Error(`Forbidden: ${action} permission required for ${resource}`);
  }

  return auth;
}
