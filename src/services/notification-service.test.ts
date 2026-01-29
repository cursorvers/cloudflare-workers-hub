/**
 * Tests for Notification Service
 *
 * Test Coverage:
 * 1. buildDiscordEmbed - Discord embed construction
 * 2. sendDiscordNotification - Discord webhook with retries
 * 3. sendSlackNotification - Slack webhook
 * 4. notifyInsight - Main notification function with priority filtering
 * 5. notifyDailyDigest - Batch notification for daily digest
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  notifyInsight,
  notifyDailyDigest,
  NotificationConfig,
} from './notification-service';
import type { Env } from '../types';
import type { Insight } from '../schemas/strategic-advisor';

// Mock dependencies
vi.mock('../utils/log-sanitizer', () => ({
  safeLog: {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Helper to create mock Env
function createMockEnv(overrides: Partial<Env> = {}): Env {
  return {
    DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/test',
    ...overrides,
  } as Env;
}

// Helper to create mock Insight
function createMockInsight(overrides: Partial<Insight> = {}): Insight {
  return {
    id: 'insight-1',
    type: 'strategic',
    title: 'Test Insight',
    description: 'Test description',
    confidence: 85,
    createdAt: Date.now(),
    ...overrides,
  } as Insight;
}

describe('Notification Service', () => {
  let env: Env;

  beforeEach(() => {
    env = createMockEnv();
    vi.clearAllMocks();
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('notifyInsight', () => {
    it('should skip notification for low priority insights', async () => {
      const insight = createMockInsight({ confidence: 50 }); // Below 70% threshold

      const result = await notifyInsight(env, insight);

      expect(result.sent).toBe(false);
      expect(result.channel).toBe('none');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should send Discord notification for high priority insights', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 204,
      });

      const insight = createMockInsight({ confidence: 80 });

      const result = await notifyInsight(env, insight);

      expect(result.sent).toBe(true);
      expect(result.channel).toBe('discord');
      expect(mockFetch).toHaveBeenCalledWith(
        'https://discord.com/api/webhooks/test',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        })
      );
    });

    it('should use custom priority threshold from config', async () => {
      const insight = createMockInsight({ confidence: 50 });
      const config: NotificationConfig = {
        minPriorityForNotification: 0.4, // 40% threshold
      };

      mockFetch.mockResolvedValueOnce({ ok: true, status: 204 });

      const result = await notifyInsight(env, insight, config);

      expect(result.sent).toBe(true);
    });

    it('should respect enableDiscord=false config', async () => {
      const insight = createMockInsight({ confidence: 80 });
      const config: NotificationConfig = {
        enableDiscord: false,
      };

      const result = await notifyInsight(env, insight, config);

      expect(result.sent).toBe(false);
      expect(result.channel).toBe('none');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should fall back to Slack when Discord unavailable', async () => {
      const envWithSlack = createMockEnv({
        DISCORD_WEBHOOK_URL: undefined,
      });
      (envWithSlack as any).SLACK_WEBHOOK_URL = 'https://hooks.slack.com/test';

      const insight = createMockInsight({ confidence: 80 });
      const config: NotificationConfig = {
        enableSlack: true,
      };

      mockFetch.mockResolvedValueOnce({ ok: true });

      const result = await notifyInsight(envWithSlack, insight, config);

      expect(result.sent).toBe(true);
      expect(result.channel).toBe('slack');
    });

    it('should use config webhook URL over env', async () => {
      const insight = createMockInsight({ confidence: 80 });
      const config: NotificationConfig = {
        discordWebhookUrl: 'https://discord.com/api/webhooks/custom',
      };

      mockFetch.mockResolvedValueOnce({ ok: true, status: 204 });

      await notifyInsight(env, insight, config);

      expect(mockFetch).toHaveBeenCalledWith(
        'https://discord.com/api/webhooks/custom',
        expect.any(Object)
      );
    });
  });

  describe('Discord notification payload', () => {
    it('should construct correct embed for strategic insight', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, status: 204 });

      const insight = createMockInsight({
        type: 'strategic',
        title: 'Strategic Title',
        description: 'Strategic description',
        confidence: 90,
        suggestedAction: 'Take this action',
      });

      await notifyInsight(env, insight);

      const fetchCall = mockFetch.mock.calls[0];
      const payload = JSON.parse(fetchCall[1].body);

      expect(payload.username).toBe('FUGUE Advisor');
      expect(payload.embeds[0].title).toContain('⚡');
      expect(payload.embeds[0].title).toContain('Strategic Title');
      expect(payload.embeds[0].color).toBe(0x8b5cf6); // Purple for strategic
      expect(payload.embeds[0].fields.length).toBeGreaterThan(0);
    });

    it('should include confidence bar in embed', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, status: 204 });

      const insight = createMockInsight({ confidence: 70 });

      await notifyInsight(env, insight);

      const fetchCall = mockFetch.mock.calls[0];
      const payload = JSON.parse(fetchCall[1].body);
      const confidenceField = payload.embeds[0].fields.find(
        (f: any) => f.name === 'Confidence'
      );

      expect(confidenceField).toBeDefined();
      expect(confidenceField.value).toContain('█');
      expect(confidenceField.value).toContain('70%');
    });

    it('should truncate long suggested actions', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, status: 204 });

      const longAction = 'A'.repeat(300);
      const insight = createMockInsight({ suggestedAction: longAction });

      await notifyInsight(env, insight);

      const fetchCall = mockFetch.mock.calls[0];
      const payload = JSON.parse(fetchCall[1].body);
      const actionField = payload.embeds[0].fields.find(
        (f: any) => f.name === 'Suggested Action'
      );

      expect(actionField.value.length).toBeLessThan(250);
      expect(actionField.value).toContain('...');
    });
  });

  describe('Discord retry logic', () => {
    it('should retry on 429 rate limit', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
          headers: new Headers({ 'Retry-After': '1' }),
        })
        .mockResolvedValueOnce({ ok: true, status: 204 });

      const insight = createMockInsight({ confidence: 80 });

      const result = await notifyInsight(env, insight);

      expect(result.sent).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('should fail after max retries', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
      });

      const insight = createMockInsight({ confidence: 80 });

      const result = await notifyInsight(env, insight);

      expect(result.sent).toBe(false);
      expect(result.error).toBe('Max retries exceeded');
      expect(mockFetch).toHaveBeenCalledTimes(3); // Initial + 2 retries
    });

    it('should handle network errors', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));

      const insight = createMockInsight({ confidence: 80 });

      const result = await notifyInsight(env, insight);

      expect(result.sent).toBe(false);
      expect(result.error).toBe('Network error');
    });
  });

  describe('Slack notification', () => {
    it('should send correct Slack payload', async () => {
      const envWithSlack = createMockEnv({
        DISCORD_WEBHOOK_URL: undefined,
      });
      (envWithSlack as any).SLACK_WEBHOOK_URL = 'https://hooks.slack.com/test';

      const config: NotificationConfig = { enableSlack: true };
      const insight = createMockInsight({
        type: 'tactical',
        title: 'Tactical Title',
        confidence: 80,
      });

      mockFetch.mockResolvedValueOnce({ ok: true });

      await notifyInsight(envWithSlack, insight, config);

      const fetchCall = mockFetch.mock.calls[0];
      const payload = JSON.parse(fetchCall[1].body);

      expect(payload.blocks).toBeDefined();
      expect(payload.blocks[0].type).toBe('header');
      expect(payload.blocks[0].text.text).toContain('🎯'); // Tactical emoji
    });

    it('should handle Slack webhook errors', async () => {
      const envWithSlack = createMockEnv({
        DISCORD_WEBHOOK_URL: undefined,
      });
      (envWithSlack as any).SLACK_WEBHOOK_URL = 'https://hooks.slack.com/test';

      const config: NotificationConfig = { enableSlack: true };
      const insight = createMockInsight({ confidence: 80 });

      mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

      const result = await notifyInsight(envWithSlack, insight, config);

      expect(result.sent).toBe(false);
      expect(result.channel).toBe('slack');
      expect(result.error).toBe('HTTP 500');
    });
  });

  describe('notifyDailyDigest', () => {
    it('should return early when no Discord URL configured', async () => {
      const envWithoutDiscord = createMockEnv({
        DISCORD_WEBHOOK_URL: undefined,
      });

      const result = await notifyDailyDigest(envWithoutDiscord, []);

      expect(result.sent).toBe(false);
      expect(result.channel).toBe('none');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should send digest with categorized insights', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, status: 204 });

      const insights = [
        createMockInsight({ confidence: 90, title: 'High Priority 1' }),
        createMockInsight({ confidence: 85, title: 'High Priority 2' }),
        createMockInsight({ confidence: 60, title: 'Medium Priority' }),
        createMockInsight({ confidence: 40, title: 'Low Priority' }),
      ];

      const result = await notifyDailyDigest(env, insights);

      expect(result.sent).toBe(true);

      const fetchCall = mockFetch.mock.calls[0];
      const payload = JSON.parse(fetchCall[1].body);

      expect(payload.username).toBe('FUGUE Daily Digest');
      expect(payload.embeds[0].title).toContain('Daily Summary');

      const highPriorityField = payload.embeds[0].fields.find(
        (f: any) => f.name === '🔴 High Priority'
      );
      expect(highPriorityField.value).toContain('High Priority 1');
      expect(highPriorityField.value).toContain('High Priority 2');

      const mediumPriorityField = payload.embeds[0].fields.find(
        (f: any) => f.name === '🟡 Medium Priority'
      );
      expect(mediumPriorityField.value).toContain('Medium Priority');
    });

    it('should show "_None_" for empty categories', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, status: 204 });

      const insights = [
        createMockInsight({ confidence: 40, title: 'Low Only' }),
      ];

      await notifyDailyDigest(env, insights);

      const fetchCall = mockFetch.mock.calls[0];
      const payload = JSON.parse(fetchCall[1].body);

      const highPriorityField = payload.embeds[0].fields.find(
        (f: any) => f.name === '🔴 High Priority'
      );
      expect(highPriorityField.value).toBe('_None_');
    });

    it('should handle digest send error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Connection failed'));

      const insights = [createMockInsight({ confidence: 90 })];

      const result = await notifyDailyDigest(env, insights);

      expect(result.sent).toBe(false);
      expect(result.error).toBe('Connection failed');
    });
  });
});
