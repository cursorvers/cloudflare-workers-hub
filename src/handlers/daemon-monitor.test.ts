/**
 * Tests for Daemon Health Monitor
 *
 * Testing strategy:
 * 1. Skip conditions (no webhook, no daemon ever registered)
 * 2. Healthy path (clear consecutive counter)
 * 3. Alert rate limiting (cooldown period)
 * 4. Alert sending (Discord notification + consecutive tracking)
 * 5. Error handling (getDaemonHealth failure, notification failure)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleDaemonHealthCheck } from './daemon-monitor';
import { Env } from '../types';
import * as daemonModule from './daemon';
import * as notificationModule from './notifications';

// Mock dependencies
vi.mock('./daemon', () => ({
  getDaemonHealth: vi.fn(),
}));

vi.mock('./notifications', () => ({
  sendDiscordNotification: vi.fn(),
}));

vi.mock('../utils/log-sanitizer', () => ({
  safeLog: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

function createMockKV(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: vi.fn().mockImplementation((key: string) => Promise.resolve(store.get(key) ?? null)),
    put: vi.fn().mockImplementation((key: string, value: string) => {
      store.set(key, value);
      return Promise.resolve();
    }),
    delete: vi.fn().mockImplementation((key: string) => {
      store.delete(key);
      return Promise.resolve();
    }),
    list: vi.fn().mockResolvedValue({ keys: [], list_complete: true, cursor: '' }),
    getWithMetadata: vi.fn().mockResolvedValue({ value: null, metadata: null }),
  } as unknown as KVNamespace;
}

/** Simple withLock that always executes the handler (no real locking in tests) */
async function mockWithLock(
  _kv: KVNamespace,
  _lockKey: string,
  _ttl: number,
  handler: () => Promise<void>,
): Promise<void> {
  await handler();
}

describe('daemon-monitor', () => {
  let env: Env;

  beforeEach(() => {
    vi.clearAllMocks();
    env = {
      AI: {} as Ai,
      ENVIRONMENT: 'test',
      CACHE: createMockKV(),
      DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/test',
    } as Env;
  });

  describe('skip conditions', () => {
    it('should skip when DISCORD_WEBHOOK_URL is not configured', async () => {
      env.DISCORD_WEBHOOK_URL = undefined;

      await handleDaemonHealthCheck(env, mockWithLock);

      expect(daemonModule.getDaemonHealth).not.toHaveBeenCalled();
    });

    it('should skip when no daemon was ever registered and none are active', async () => {
      vi.mocked(daemonModule.getDaemonHealth).mockResolvedValue({
        activeDaemons: [],
        stale: [],
        totalActive: 0,
      });

      await handleDaemonHealthCheck(env, mockWithLock);

      // Should not send notification
      expect(notificationModule.sendDiscordNotification).not.toHaveBeenCalled();
    });
  });

  describe('healthy path', () => {
    it('should mark daemon:ever_registered when first active daemon seen', async () => {
      vi.mocked(daemonModule.getDaemonHealth).mockResolvedValue({
        activeDaemons: [{ daemonId: 'd1' } as daemonModule.DaemonState],
        stale: [],
        totalActive: 1,
      });

      await handleDaemonHealthCheck(env, mockWithLock);

      expect(env.CACHE!.put).toHaveBeenCalledWith('daemon:ever_registered', 'true');
      expect(notificationModule.sendDiscordNotification).not.toHaveBeenCalled();
    });

    it('should clear consecutive alert counter when daemons are healthy', async () => {
      // Pre-set ever_registered
      await env.CACHE!.put('daemon:ever_registered', 'true');

      vi.mocked(daemonModule.getDaemonHealth).mockResolvedValue({
        activeDaemons: [{ daemonId: 'd1' } as daemonModule.DaemonState],
        stale: [],
        totalActive: 1,
      });

      await handleDaemonHealthCheck(env, mockWithLock);

      expect(env.CACHE!.delete).toHaveBeenCalledWith('daemon:alert:consecutive');
    });
  });

  describe('alert rate limiting', () => {
    it('should skip alert when within cooldown period', async () => {
      await env.CACHE!.put('daemon:ever_registered', 'true');
      // Last alert was 10 minutes ago (within 1-hour cooldown)
      await env.CACHE!.put('daemon:alert:last', new Date(Date.now() - 10 * 60 * 1000).toISOString());

      vi.mocked(daemonModule.getDaemonHealth).mockResolvedValue({
        activeDaemons: [],
        stale: [],
        totalActive: 0,
      });

      await handleDaemonHealthCheck(env, mockWithLock);

      expect(notificationModule.sendDiscordNotification).not.toHaveBeenCalled();
    });

    it('should send alert when cooldown has expired', async () => {
      await env.CACHE!.put('daemon:ever_registered', 'true');
      // Last alert was 2 hours ago (expired cooldown)
      await env.CACHE!.put('daemon:alert:last', new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString());

      vi.mocked(daemonModule.getDaemonHealth).mockResolvedValue({
        activeDaemons: [],
        stale: [],
        totalActive: 0,
      });
      vi.mocked(notificationModule.sendDiscordNotification).mockResolvedValue();

      await handleDaemonHealthCheck(env, mockWithLock);

      expect(notificationModule.sendDiscordNotification).toHaveBeenCalled();
    });
  });

  describe('alert sending', () => {
    it('should send Discord alert with correct fields when all daemons offline', async () => {
      await env.CACHE!.put('daemon:ever_registered', 'true');

      vi.mocked(daemonModule.getDaemonHealth).mockResolvedValue({
        activeDaemons: [],
        stale: [],
        totalActive: 0,
      });
      vi.mocked(notificationModule.sendDiscordNotification).mockResolvedValue();

      await handleDaemonHealthCheck(env, mockWithLock);

      expect(notificationModule.sendDiscordNotification).toHaveBeenCalledWith(
        'https://discord.com/api/webhooks/test',
        expect.objectContaining({
          type: 'error',
          title: 'Daemon Offline Alert',
          source: 'daemon-monitor',
        }),
      );
    });

    it('should include stale daemon details in alert', async () => {
      await env.CACHE!.put('daemon:ever_registered', 'true');
      const staleHeartbeat = new Date(Date.now() - 120 * 1000).toISOString();

      vi.mocked(daemonModule.getDaemonHealth).mockResolvedValue({
        activeDaemons: [],
        stale: [{
          daemonId: 'mac-mini-01',
          lastHeartbeat: staleHeartbeat,
        } as daemonModule.DaemonState],
        totalActive: 0,
      });
      vi.mocked(notificationModule.sendDiscordNotification).mockResolvedValue();

      await handleDaemonHealthCheck(env, mockWithLock);

      const call = vi.mocked(notificationModule.sendDiscordNotification).mock.calls[0];
      const notification = call[1] as notificationModule.Notification;
      expect(notification.fields).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'Stale Daemons' }),
        ]),
      );
    });

    it('should track consecutive alerts', async () => {
      await env.CACHE!.put('daemon:ever_registered', 'true');

      vi.mocked(daemonModule.getDaemonHealth).mockResolvedValue({
        activeDaemons: [],
        stale: [],
        totalActive: 0,
      });
      vi.mocked(notificationModule.sendDiscordNotification).mockResolvedValue();

      // First alert
      await handleDaemonHealthCheck(env, mockWithLock);
      expect(env.CACHE!.put).toHaveBeenCalledWith(
        'daemon:alert:consecutive',
        '1',
        expect.objectContaining({ expirationTtl: 86400 }),
      );

      // Clear cooldown for second alert
      await env.CACHE!.delete('daemon:alert:last');

      // Second alert
      await handleDaemonHealthCheck(env, mockWithLock);
      expect(env.CACHE!.put).toHaveBeenCalledWith(
        'daemon:alert:consecutive',
        '2',
        expect.objectContaining({ expirationTtl: 86400 }),
      );
    });

    it('should record alert timestamp after sending', async () => {
      await env.CACHE!.put('daemon:ever_registered', 'true');

      vi.mocked(daemonModule.getDaemonHealth).mockResolvedValue({
        activeDaemons: [],
        stale: [],
        totalActive: 0,
      });
      vi.mocked(notificationModule.sendDiscordNotification).mockResolvedValue();

      await handleDaemonHealthCheck(env, mockWithLock);

      expect(env.CACHE!.put).toHaveBeenCalledWith(
        'daemon:alert:last',
        expect.any(String),
        expect.objectContaining({ expirationTtl: 3600 }),
      );
    });
  });

  describe('error handling', () => {
    it('should handle getDaemonHealth failure gracefully', async () => {
      vi.mocked(daemonModule.getDaemonHealth).mockRejectedValue(new Error('KV error'));

      await expect(handleDaemonHealthCheck(env, mockWithLock)).resolves.not.toThrow();
      expect(notificationModule.sendDiscordNotification).not.toHaveBeenCalled();
    });

    it('should handle sendDiscordNotification failure gracefully', async () => {
      await env.CACHE!.put('daemon:ever_registered', 'true');

      vi.mocked(daemonModule.getDaemonHealth).mockResolvedValue({
        activeDaemons: [],
        stale: [],
        totalActive: 0,
      });
      vi.mocked(notificationModule.sendDiscordNotification).mockRejectedValue(
        new Error('Discord API error'),
      );

      await expect(handleDaemonHealthCheck(env, mockWithLock)).resolves.not.toThrow();
    });
  });
});
