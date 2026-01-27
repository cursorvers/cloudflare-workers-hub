/**
 * Task Index Cache
 *
 * Reduces KV list() operations by caching task IDs in a single KV key.
 * Cloudflare free plan allows only 1,000 list ops/day but 100,000 read ops/day.
 * This cache converts list calls into read calls with periodic refresh.
 *
 * Cache strategy:
 * - getTaskIds(): read cache (KV get) → on miss/expired → KV list → update cache
 * - addToTaskIndex(): no-op (avoids write amplification; cache refreshes naturally)
 * - removeFromTaskIndex(): invalidate cache (delete key) so next read does fresh list
 * - On KV list failure: fall back to stale cache (max 30 min) or empty list
 */

import { safeLog } from './log-sanitizer';

export const TASK_INDEX_KEY = 'queue:task-index';
export const CACHE_VALIDITY_SEC = 300; // 5 minutes
const MAX_STALE_AGE_SEC = 1800; // 30 minutes — stale cache hard limit

export interface TaskIndex {
  ids: string[];
  cachedAt: number; // Unix timestamp ms
}

/**
 * Get task IDs with caching. Falls back gracefully on KV list failure.
 *
 * Cost per call:
 * - Cache hit: 1 KV get (free: 100k/day)
 * - Cache miss: 1 KV get + 1 KV list + 1 KV put
 * - KV list failure: 1 KV get (stale cache, max 30 min) or empty
 */
export async function getTaskIds(kv: KVNamespace): Promise<string[]> {
  // Try cached index first (KV get = 100k/day limit)
  let cached: TaskIndex | null = null;
  try {
    cached = await kv.get<TaskIndex>(TASK_INDEX_KEY, 'json');
    if (cached && Date.now() - cached.cachedAt < CACHE_VALIDITY_SEC * 1000) {
      return cached.ids;
    }
  } catch {
    // Cache read failed, try list
  }

  // Cache miss or expired — do actual KV list
  try {
    const taskKeys = await kv.list({ prefix: 'queue:task:' });
    const ids = taskKeys.keys.map(key => key.name.replace('queue:task:', ''));

    // Update cache (TTL = 2x validity so stale reads work)
    await kv.put(TASK_INDEX_KEY, JSON.stringify({
      ids,
      cachedAt: Date.now(),
    } satisfies TaskIndex), { expirationTtl: CACHE_VALIDITY_SEC * 2 });

    return ids;
  } catch (e) {
    // KV list failed (likely daily limit) — fall back to stale cache
    if (cached) {
      const staleAgeSec = Math.round((Date.now() - cached.cachedAt) / 1000);
      if (staleAgeSec > MAX_STALE_AGE_SEC) {
        safeLog.error('[TaskIndex] Stale cache too old, discarding', {
          staleAge: staleAgeSec + 's',
          maxAge: MAX_STALE_AGE_SEC + 's',
        });
        return [];
      }
      safeLog.warn('[TaskIndex] KV list failed, using stale cache', {
        error: String(e),
        staleAge: staleAgeSec + 's',
      });
      return cached.ids;
    }

    safeLog.error('[TaskIndex] KV list failed, no cache available', { error: String(e) });
    return [];
  }
}

/**
 * Called when a new task is enqueued.
 *
 * No-op: avoids write amplification and read-modify-write race conditions.
 * New tasks become visible when cache expires (≤5 min) and getTaskIds()
 * does a fresh KV list. Acceptable latency for 2-min daemon polling.
 */
export async function addToTaskIndex(_kv: KVNamespace, _taskId: string): Promise<void> {
  // Intentional no-op — see doc comment above
}

/**
 * Called when a task is completed/removed.
 *
 * Invalidates cache so the next getTaskIds() call does a fresh KV list.
 * This ensures completed tasks stop appearing in the claim list promptly.
 * Cost: 1 KV delete (counted toward 1k/day delete limit).
 */
export async function removeFromTaskIndex(kv: KVNamespace, _taskId: string): Promise<void> {
  try {
    await kv.delete(TASK_INDEX_KEY);
  } catch {
    // Best effort — cache will expire naturally
  }
}
