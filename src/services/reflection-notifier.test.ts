/**
 * Tests for Reflection Notification Service
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  sendReflectionNotification,
  sendMultiChannelNotification,
  type NotificationChannel,
  type ReflectionNotification,
} from './reflection-notifier';
import type { Env } from '../types';

// Mock environment
const createMockEnv = (overrides?: Partial<Env>): Env => ({
  SUPABASE_URL: 'https://test.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'test-key',
  DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/test',
  SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/test',
  CACHE: {} as KVNamespace,
  ...overrides,
} as Env);

// Mock fetch globally
const originalFetch = global.fetch;

describe('Reflection Notifier', () => {
  let mockEnv: Env;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockEnv = createMockEnv();
    fetchMock = vi.fn();
    global.fetch = fetchMock;

    // Mock KV namespace
    const kvMock = {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
    };
    mockEnv.CACHE = kvMock as unknown as KVNamespace;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.clearAllMocks();
  });

  describe('sendReflectionNotification', () => {
    const testNotification: ReflectionNotification = {
      highlight_id: 'test-123',
      highlight_time: '2026-02-01T12:00:00Z',
      extracted_text: 'Test reflection text',
      speaker_name: 'Test Speaker',
      topics: ['health', 'wellness'],
      notification_url: 'https://example.com/reflection/test-123',
    };

    it('sends Discord notification successfully', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 204,
      });

      const result = await sendReflectionNotification(mockEnv, 'discord', testNotification);

      expect(result.success).toBe(true);
      expect(result.channel).toBe('discord');
      expect(fetchMock).toHaveBeenCalledWith(
        mockEnv.DISCORD_WEBHOOK_URL,
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        })
      );
    });

    it('sends Slack notification successfully', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
      });

      const result = await sendReflectionNotification(mockEnv, 'slack', testNotification);

      expect(result.success).toBe(true);
      expect(result.channel).toBe('slack');
      expect(fetchMock).toHaveBeenCalledWith(
        mockEnv.SLACK_WEBHOOK_URL,
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        })
      );
    });

    it('handles Discord notification failure gracefully', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
      });

      const result = await sendReflectionNotification(mockEnv, 'discord', testNotification);

      expect(result.success).toBe(false);
      expect(result.channel).toBe('discord');
      expect(result.error).toContain('Discord webhook returned 400');
    });

    it('returns error when Discord webhook is not configured', async () => {
      const envWithoutDiscord = createMockEnv({ DISCORD_WEBHOOK_URL: undefined });

      const result = await sendReflectionNotification(
        envWithoutDiscord,
        'discord',
        testNotification
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('Discord webhook URL not configured');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('respects frequency control (24-hour throttle) when not forced', async () => {
      // Mock KV to return a recent timestamp (within 24 hours)
      const recentTimestamp = Date.now() - 12 * 60 * 60 * 1000; // 12 hours ago
      const kvMock = mockEnv.CACHE as unknown as {
        get: ReturnType<typeof vi.fn>;
        put: ReturnType<typeof vi.fn>;
      };
      kvMock.get.mockResolvedValueOnce(recentTimestamp.toString());

      const result = await sendReflectionNotification(mockEnv, 'discord', testNotification, false);

      expect(result.success).toBe(false);
      expect(result.error).toContain('notification sent within 24 hours');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('bypasses frequency control when forced', async () => {
      // Mock KV to return a recent timestamp
      const recentTimestamp = Date.now() - 1 * 60 * 60 * 1000; // 1 hour ago
      const kvMock = mockEnv.CACHE as unknown as {
        get: ReturnType<typeof vi.fn>;
        put: ReturnType<typeof vi.fn>;
      };
      kvMock.get.mockResolvedValueOnce(recentTimestamp.toString());

      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 204,
      });

      const result = await sendReflectionNotification(mockEnv, 'discord', testNotification, true);

      expect(result.success).toBe(true);
      expect(fetchMock).toHaveBeenCalled(); // Should bypass throttle
    });

    it('allows notification after 24-hour period', async () => {
      // Mock KV to return an old timestamp (more than 24 hours ago)
      const oldTimestamp = Date.now() - 25 * 60 * 60 * 1000; // 25 hours ago
      const kvMock = mockEnv.CACHE as unknown as {
        get: ReturnType<typeof vi.fn>;
        put: ReturnType<typeof vi.fn>;
      };
      kvMock.get.mockResolvedValueOnce(oldTimestamp.toString());

      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 204,
      });

      const result = await sendReflectionNotification(mockEnv, 'discord', testNotification, false);

      expect(result.success).toBe(true);
      expect(fetchMock).toHaveBeenCalled();
    });
  });

  describe('sendMultiChannelNotification', () => {
    const testNotification: ReflectionNotification = {
      highlight_id: 'test-456',
      highlight_time: '2026-02-01T15:00:00Z',
      extracted_text: 'Multi-channel test',
      speaker_name: null,
      topics: ['test'],
      notification_url: 'https://example.com/reflection/test-456',
    };

    it('sends to multiple channels in parallel', async () => {
      fetchMock
        .mockResolvedValueOnce({ ok: true, status: 204 }) // Discord
        .mockResolvedValueOnce({ ok: true, status: 200 }); // Slack

      const channels: NotificationChannel[] = ['discord', 'slack'];
      const results = await sendMultiChannelNotification(mockEnv, channels, testNotification);

      expect(results).toHaveLength(2);
      expect(results[0].success).toBe(true);
      expect(results[0].channel).toBe('discord');
      expect(results[1].success).toBe(true);
      expect(results[1].channel).toBe('slack');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('returns partial success when one channel fails', async () => {
      fetchMock
        .mockResolvedValueOnce({ ok: true, status: 204 }) // Discord success
        .mockResolvedValueOnce({ ok: false, status: 500 }); // Slack failure

      const channels: NotificationChannel[] = ['discord', 'slack'];
      const results = await sendMultiChannelNotification(mockEnv, channels, testNotification);

      expect(results).toHaveLength(2);
      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(false);
    });

    it('handles empty channel array', async () => {
      const results = await sendMultiChannelNotification(mockEnv, [], testNotification);

      expect(results).toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('propagates force flag to all channels', async () => {
      const recentTimestamp = Date.now() - 1 * 60 * 60 * 1000; // 1 hour ago
      const kvMock = mockEnv.CACHE as unknown as {
        get: ReturnType<typeof vi.fn>;
        put: ReturnType<typeof vi.fn>;
      };
      kvMock.get.mockResolvedValue(recentTimestamp.toString());

      fetchMock.mockResolvedValue({ ok: true, status: 204 });

      const channels: NotificationChannel[] = ['discord', 'slack'];
      const results = await sendMultiChannelNotification(
        mockEnv,
        channels,
        testNotification,
        true // force = true
      );

      expect(results).toHaveLength(2);
      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2); // Both should bypass throttle
    });
  });
});
