/**
 * Initialization Handler
 *
 * Service role KV mappings for system API keys.
 * Runs once per isolate lifecycle.
 */

import { Env } from '../types';
import { hashAPIKey } from '../utils/api-auth';
import { safeLog } from '../utils/log-sanitizer';

/**
 * Ensure service role KV mappings exist for system API keys.
 * Runs once on first request. Idempotent - skips if mapping already exists.
 */
export async function ensureServiceRoleMappings(env: Env): Promise<void> {
  if (!env.CACHE) return;

  const keysToMap: Array<{ key: string | undefined; serviceId: string }> = [
    { key: env.ASSISTANT_API_KEY, serviceId: 'system-daemon' },
    { key: env.ADMIN_API_KEY, serviceId: 'system-admin' },
  ];

  for (const { key, serviceId } of keysToMap) {
    if (!key) continue;
    const keyHash = await hashAPIKey(key);
    const mappingKey = `apikey:mapping:${keyHash}`;

    const existing = await env.CACHE.get(mappingKey);
    if (existing) continue;

    await env.CACHE.put(mappingKey, JSON.stringify({ userId: serviceId, role: 'service' }));
    safeLog.log('[Init] Created service role mapping', { serviceId, keyHash: keyHash.substring(0, 8) });
  }
}
