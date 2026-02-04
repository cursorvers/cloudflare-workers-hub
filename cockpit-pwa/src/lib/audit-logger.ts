/**
 * Audit Logging Utility
 *
 * Tracks all data modifications for compliance and debugging
 */

import { drizzle } from 'drizzle-orm/d1';
import type { D1Database } from '@cloudflare/workers-types';
import { cockpitAuditLogs, type NewAuditLog } from '@/db/schema';

export interface AuditContext {
  userId: string;
  ipAddress?: string;
  userAgent?: string;
}

export async function logAudit(
  db: D1Database,
  context: AuditContext,
  action: string,
  entityType: string,
  entityId: string,
  changes?: Record<string, unknown>
): Promise<void> {
  const drizzleDb = drizzle(db);

  const auditEntry: NewAuditLog = {
    userId: context.userId,
    action,
    entityType,
    entityId,
    changes: changes ? JSON.stringify(changes) : undefined,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  };

  await drizzleDb.insert(cockpitAuditLogs).values(auditEntry).run();
}

/**
 * Create audit context from request headers
 */
export function createAuditContext(
  userId: string,
  headers?: Headers
): AuditContext {
  return {
    userId,
    ipAddress: headers?.get('cf-connecting-ip') || headers?.get('x-forwarded-for') || undefined,
    userAgent: headers?.get('user-agent') || undefined,
  };
}
