/**
 * Tests for Task Index Cache
 *
 * Testing strategy:
 * 1. Cache hit/miss/expired scenarios
 * 2. KV list failure with stale fallback (max 30 min)
 * 3. addToTaskIndex is a no-op (write amplification prevention)
 * 4. removeFromTaskIndex invalidates cache (delete key)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getTaskIds,
  addToTaskIndex,
  removeFromTaskIndex,
  TASK_INDEX_KEY,
  CACHE_VALIDITY_SEC,
  type TaskIndex,
} from './task-index';

function createMockKV(overrides: Partial<Record<'get' | 'put' | 'delete' | 'list', unknown>> = {}): KVNamespace {
  return {
    get: vi.fn().mockResolvedValue(null),
    put: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue({ keys: [], list_complete: true, cursor: '' }),
    getWithMetadata: vi.fn().mockResolvedValue({ value: null, metadata: null }),
    ...overrides,
  } as unknown as KVNamespace;
}

describe('task-index', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  describe('getTaskIds', () => {
    it('should return cached IDs when cache is fresh (cache hit)', async () => {
      const freshCache: TaskIndex = {
        ids: ['task-1', 'task-2', 'task-3'],
        cachedAt: Date.now() - 100_000, // 100 seconds ago (< 5 min)
      };

      const mockKV = createMockKV({
        get: vi.fn().mockResolvedValue(freshCache),
      });

      const result = await getTaskIds(mockKV);

      expect(result).toEqual(['task-1', 'task-2', 'task-3']);
      expect(mockKV.get).toHaveBeenCalledWith(TASK_INDEX_KEY, 'json');
      expect(mockKV.list).not.toHaveBeenCalled();
    });

    it('should fetch from KV list when cache is null (cache miss)', async () => {
      const mockKV = createMockKV({
        get: vi.fn().mockResolvedValue(null),
        list: vi.fn().mockResolvedValue({
          keys: [
            { name: 'queue:task:abc-123' },
            { name: 'queue:task:def-456' },
          ],
          list_complete: true,
          cursor: '',
        }),
      });

      const result = await getTaskIds(mockKV);

      expect(result).toEqual(['abc-123', 'def-456']);
      expect(mockKV.list).toHaveBeenCalledWith({ prefix: 'queue:task:' });
      expect(mockKV.put).toHaveBeenCalledWith(
        TASK_INDEX_KEY,
        expect.stringContaining('"abc-123"'),
        { expirationTtl: CACHE_VALIDITY_SEC * 2 },
      );
    });

    it('should refresh cache when expired', async () => {
      const expiredCache: TaskIndex = {
        ids: ['old-1', 'old-2'],
        cachedAt: Date.now() - (CACHE_VALIDITY_SEC + 100) * 1000, // > 5 min ago
      };

      const mockKV = createMockKV({
        get: vi.fn().mockResolvedValue(expiredCache),
        list: vi.fn().mockResolvedValue({
          keys: [{ name: 'queue:task:new-1' }],
          list_complete: true,
          cursor: '',
        }),
      });

      const result = await getTaskIds(mockKV);

      expect(result).toEqual(['new-1']);
      expect(mockKV.list).toHaveBeenCalled();
      expect(mockKV.put).toHaveBeenCalled();
    });

    it('should return stale cache when KV list fails and cache age < 30 min', async () => {
      const staleCache: TaskIndex = {
        ids: ['stale-1', 'stale-2'],
        cachedAt: Date.now() - 20 * 60 * 1000, // 20 minutes ago (< 30 min)
      };

      const mockKV = createMockKV({
        get: vi.fn().mockResolvedValue(staleCache),
        list: vi.fn().mockRejectedValue(new Error('KV list limit exceeded')),
      });

      const result = await getTaskIds(mockKV);

      expect(result).toEqual(['stale-1', 'stale-2']);
      // safeLog.warn outputs a JSON string to console.warn
      expect(console.warn).toHaveBeenCalled();
    });

    it('should return empty array when KV list fails and cache age > 30 min', async () => {
      const veryStaleCache: TaskIndex = {
        ids: ['very-stale-1'],
        cachedAt: Date.now() - 35 * 60 * 1000, // 35 minutes ago (> 30 min)
      };

      const mockKV = createMockKV({
        get: vi.fn().mockResolvedValue(veryStaleCache),
        list: vi.fn().mockRejectedValue(new Error('KV list limit exceeded')),
      });

      const result = await getTaskIds(mockKV);

      expect(result).toEqual([]);
      // safeLog.error for stale cache too old
      expect(console.error).toHaveBeenCalled();
    });

    it('should return empty array when KV list fails and no cache exists', async () => {
      const mockKV = createMockKV({
        get: vi.fn().mockResolvedValue(null),
        list: vi.fn().mockRejectedValue(new Error('KV list limit exceeded')),
      });

      const result = await getTaskIds(mockKV);

      expect(result).toEqual([]);
      expect(console.error).toHaveBeenCalled();
    });

    it('should fall through to KV list when cache read throws', async () => {
      const mockKV = createMockKV({
        get: vi.fn().mockRejectedValue(new Error('Cache read error')),
        list: vi.fn().mockResolvedValue({
          keys: [{ name: 'queue:task:fallback-1' }],
          list_complete: true,
          cursor: '',
        }),
      });

      const result = await getTaskIds(mockKV);

      expect(result).toEqual(['fallback-1']);
      expect(mockKV.list).toHaveBeenCalled();
    });

    it('should handle empty task list', async () => {
      const mockKV = createMockKV({
        get: vi.fn().mockResolvedValue(null),
        list: vi.fn().mockResolvedValue({ keys: [], list_complete: true, cursor: '' }),
      });

      const result = await getTaskIds(mockKV);

      expect(result).toEqual([]);
      expect(mockKV.put).toHaveBeenCalledWith(
        TASK_INDEX_KEY,
        expect.stringContaining('"ids":[]'),
        { expirationTtl: CACHE_VALIDITY_SEC * 2 },
      );
    });
  });

  describe('addToTaskIndex', () => {
    it('should be a no-op (does not call any KV methods)', async () => {
      const mockKV = createMockKV();

      await addToTaskIndex(mockKV, 'test-task-id');

      expect(mockKV.get).not.toHaveBeenCalled();
      expect(mockKV.put).not.toHaveBeenCalled();
      expect(mockKV.delete).not.toHaveBeenCalled();
      expect(mockKV.list).not.toHaveBeenCalled();
    });
  });

  describe('removeFromTaskIndex', () => {
    it('should delete cache key to invalidate', async () => {
      const mockKV = createMockKV();

      await removeFromTaskIndex(mockKV, 'test-task-id');

      expect(mockKV.delete).toHaveBeenCalledWith(TASK_INDEX_KEY);
    });

    it('should not throw when delete fails (best effort)', async () => {
      const mockKV = createMockKV({
        delete: vi.fn().mockRejectedValue(new Error('Delete failed')),
      });

      await expect(removeFromTaskIndex(mockKV, 'test-task-id')).resolves.not.toThrow();
    });
  });

  describe('constants', () => {
    it('should export correct values', () => {
      expect(TASK_INDEX_KEY).toBe('queue:task-index');
      expect(CACHE_VALIDITY_SEC).toBe(300);
    });
  });
});
