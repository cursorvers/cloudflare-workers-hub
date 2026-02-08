/**
 * Initialization Handler
 *
 * Service role mappings for system API keys.
 * Runs once per isolate lifecycle.
 */

import { Env } from '../types';
import { hashAPIKey } from '../utils/api-auth';
import { safeLog } from '../utils/log-sanitizer';

/**
 * Ensure service role mappings exist for system API keys.
 * Runs once on first request. Idempotent - skips if mapping already exists.
 */
export async function ensureServiceRoleMappings(env: Env): Promise<void> {
  if (!env.DB) return;

  const keysToMap: Array<{ key: string | undefined; serviceId: string }> = [
    { key: env.ASSISTANT_API_KEY, serviceId: 'system-daemon' },
    { key: env.ADMIN_API_KEY, serviceId: 'system-admin' },
  ];

  for (const { key, serviceId } of keysToMap) {
    if (!key) continue;
    const keyHash = await hashAPIKey(key);
    try {
      await env.DB.prepare(
        `INSERT INTO api_key_mappings (key_hash, user_id, role, updated_at)
         VALUES (?, ?, 'service', strftime('%s','now'))
         ON CONFLICT(key_hash) DO NOTHING`
      ).bind(keyHash, serviceId).run();
    } catch (error) {
      safeLog.error('[Init] Failed to create service role mapping in D1', { error: String(error) });
      continue;
    }
    safeLog.log('[Init] Created service role mapping', { serviceId, keyHash: keyHash.substring(0, 8) });
  }
}
