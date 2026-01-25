/**
 * Tests for Scheduled Handler (Cron Triggers)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { handleScheduled } from './scheduled';
import { Env } from '../types';
import * as limitlessService from '../services/limitless';

// Mock limitless service
vi.mock('../services/limitless', () => ({
  syncToKnowledge: vi.fn(),
}));

// Mock safeLog
vi.mock('../utils/log-sanitizer', () => ({
  safeLog: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('Scheduled Handler', () => {
  let env: Env;
  let controller: ScheduledController;
  let ctx: ExecutionContext;

  beforeEach(() => {
    vi.clearAllMocks();

    // Mock environment
    env = {
      AI: {} as Ai,
      ENVIRONMENT: 'test',
      CACHE: {
        get: vi.fn(),
        put: vi.fn(),
      } as unknown as KVNamespace,
    } as Env;

    // Mock scheduled controller
    controller = {
      scheduledTime: Date.now(),
      cron: '0 * * * *',
    };

    // Mock execution context
    ctx = {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
    } as unknown as ExecutionContext;
  });

  it('should skip sync when auto-sync is disabled', async () => {
    env.LIMITLESS_AUTO_SYNC_ENABLED = 'false';

    await handleScheduled(controller, env, ctx);

    expect(limitlessService.syncToKnowledge).not.toHaveBeenCalled();
  });

  it('should skip sync when LIMITLESS_API_KEY is not configured', async () => {
    env.LIMITLESS_AUTO_SYNC_ENABLED = 'true';

    await handleScheduled(controller, env, ctx);

    expect(limitlessService.syncToKnowledge).not.toHaveBeenCalled();
  });

  it('should skip sync when LIMITLESS_USER_ID is not configured', async () => {
    env.LIMITLESS_AUTO_SYNC_ENABLED = 'true';
    env.LIMITLESS_API_KEY = 'test-api-key';

    await handleScheduled(controller, env, ctx);

    expect(limitlessService.syncToKnowledge).not.toHaveBeenCalled();
  });

  it('should perform sync when enabled and configured', async () => {
    env.LIMITLESS_AUTO_SYNC_ENABLED = 'true';
    env.LIMITLESS_API_KEY = 'test-api-key';
    env.LIMITLESS_USER_ID = 'test-user';

    // Mock KV to return null (no previous sync)
    vi.mocked(env.CACHE!.get).mockResolvedValue(null);

    // Mock sync result
    vi.mocked(limitlessService.syncToKnowledge).mockResolvedValue({
      synced: 5,
      skipped: 2,
      errors: [],
    });

    await handleScheduled(controller, env, ctx);

    expect(limitlessService.syncToKnowledge).toHaveBeenCalledWith(
      env,
      'test-api-key',
      expect.objectContaining({
        userId: 'test-user',
        includeAudio: false,
      })
    );

    // Should update last sync time
    expect(env.CACHE!.put).toHaveBeenCalledWith(
      'limitless:last_sync:test-user',
      expect.any(String)
    );

    // Should update sync stats
    expect(env.CACHE!.put).toHaveBeenCalledWith(
      'limitless:sync_stats:test-user',
      expect.stringContaining('"synced":5')
    );
  });

  it('should skip sync if last sync was too recent', async () => {
    env.LIMITLESS_AUTO_SYNC_ENABLED = 'true';
    env.LIMITLESS_API_KEY = 'test-api-key';
    env.LIMITLESS_USER_ID = 'test-user';
    env.LIMITLESS_SYNC_INTERVAL_HOURS = '2'; // 2 hour interval

    // Mock KV to return recent sync time (30 minutes ago)
    const recentSync = new Date(Date.now() - 30 * 60 * 1000);
    vi.mocked(env.CACHE!.get).mockResolvedValue(recentSync.toISOString());

    await handleScheduled(controller, env, ctx);

    expect(limitlessService.syncToKnowledge).not.toHaveBeenCalled();
  });

  it('should sync if last sync exceeded interval', async () => {
    env.LIMITLESS_AUTO_SYNC_ENABLED = 'true';
    env.LIMITLESS_API_KEY = 'test-api-key';
    env.LIMITLESS_USER_ID = 'test-user';
    env.LIMITLESS_SYNC_INTERVAL_HOURS = '1'; // 1 hour interval

    // Mock KV to return old sync time (2 hours ago)
    const oldSync = new Date(Date.now() - 2 * 60 * 60 * 1000);
    vi.mocked(env.CACHE!.get).mockResolvedValue(oldSync.toISOString());

    // Mock sync result
    vi.mocked(limitlessService.syncToKnowledge).mockResolvedValue({
      synced: 3,
      skipped: 1,
      errors: [],
    });

    await handleScheduled(controller, env, ctx);

    expect(limitlessService.syncToKnowledge).toHaveBeenCalled();
  });

  it('should handle sync errors gracefully', async () => {
    env.LIMITLESS_AUTO_SYNC_ENABLED = 'true';
    env.LIMITLESS_API_KEY = 'test-api-key';
    env.LIMITLESS_USER_ID = 'test-user';

    vi.mocked(env.CACHE!.get).mockResolvedValue(null);

    // Mock sync error
    vi.mocked(limitlessService.syncToKnowledge).mockRejectedValue(
      new Error('API error')
    );

    // Should not throw
    await expect(handleScheduled(controller, env, ctx)).resolves.toBeUndefined();

    expect(limitlessService.syncToKnowledge).toHaveBeenCalled();
  });

  it('should use custom sync interval from env', async () => {
    env.LIMITLESS_AUTO_SYNC_ENABLED = 'true';
    env.LIMITLESS_API_KEY = 'test-api-key';
    env.LIMITLESS_USER_ID = 'test-user';
    env.LIMITLESS_SYNC_INTERVAL_HOURS = '4'; // Custom 4 hour interval

    vi.mocked(env.CACHE!.get).mockResolvedValue(null);

    vi.mocked(limitlessService.syncToKnowledge).mockResolvedValue({
      synced: 2,
      skipped: 0,
      errors: [],
    });

    await handleScheduled(controller, env, ctx);

    expect(limitlessService.syncToKnowledge).toHaveBeenCalledWith(
      env,
      'test-api-key',
      expect.objectContaining({
        maxAgeHours: 5, // syncIntervalHours + 1
      })
    );
  });
});
