import { describe, expect, it, vi, beforeEach } from 'vitest';

import {
  NOTIFICATION_TYPES,
  createNotification,
  buildDiscordPayload,
  buildSlackPayload,
  dispatchNotification,
} from '../notification-dispatcher';
import type { Env } from '../../../../types';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function createEnv(overrides: Partial<Env> = {}): Env {
  return {
    AI: {} as Ai,
    ENVIRONMENT: 'test',
    ...overrides,
  };
}

describe('fugue/autopilot/notify/notification-dispatcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue(new Response('ok', { status: 200 }));
  });

  describe('NOTIFICATION_TYPES', () => {
    it('exports all 7 notification types', () => {
      expect(NOTIFICATION_TYPES).toHaveLength(7);
      expect(NOTIFICATION_TYPES).toContain('auto_stop');
      expect(NOTIFICATION_TYPES).toContain('recovery_completed');
      expect(NOTIFICATION_TYPES).toContain('budget_critical');
    });
  });

  describe('createNotification', () => {
    it('creates auto_stop notification with critical severity', () => {
      const n = createNotification('auto_stop', { reasons: 'budget critical' });
      expect(n.type).toBe('auto_stop');
      expect(n.severity).toBe('critical');
      expect(n.title).toContain('Auto-STOP');
      expect(n.message).toContain('budget critical');
      expect(Object.isFrozen(n)).toBe(true);
    });

    it('creates budget_warning notification with warning severity', () => {
      const n = createNotification('budget_warning', { percentage: '95.5' });
      expect(n.severity).toBe('warning');
      expect(n.message).toContain('95.5');
    });

    it('creates recovery_completed notification with info severity', () => {
      const n = createNotification('recovery_completed', { approvedBy: 'admin' });
      expect(n.severity).toBe('info');
      expect(n.message).toContain('admin');
    });

    it('handles empty details', () => {
      const n = createNotification('heartbeat_stale');
      expect(n.metadata).toBeUndefined();
    });
  });

  describe('buildDiscordPayload', () => {
    it('builds valid Discord embed', () => {
      const n = createNotification('auto_stop', { reasons: 'test' });
      const payload = buildDiscordPayload(n);
      expect(payload.embeds).toHaveLength(1);
      const embed = (payload.embeds as Record<string, unknown>[])[0];
      expect(embed.color).toBe(0xFF0000);
    });

    it('includes metadata as fields', () => {
      const n = createNotification('budget_warning', { percentage: 95, threshold: 98 });
      const payload = buildDiscordPayload(n);
      const embed = (payload.embeds as Record<string, unknown>[])[0];
      expect((embed.fields as unknown[]).length).toBeGreaterThan(0);
    });
  });

  describe('buildSlackPayload', () => {
    it('builds valid Slack block kit message', () => {
      const n = createNotification('circuit_open', { failures: 5 });
      const payload = buildSlackPayload(n);
      expect(payload.text).toContain('Circuit Breaker');
      expect((payload.blocks as unknown[]).length).toBeGreaterThan(0);
    });
  });

  describe('dispatchNotification', () => {
    it('sends to Discord when webhook configured', async () => {
      const env = createEnv({ DISCORD_WEBHOOK_URL: 'https://discord.test/webhook' });
      const n = createNotification('auto_stop');
      const result = await dispatchNotification(env, n);
      expect(result.sent).toBe(true);
      expect(result.channel).toBe('discord');
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('falls back to Slack when Discord fails', async () => {
      mockFetch
        .mockResolvedValueOnce(new Response('error', { status: 500 }))
        .mockResolvedValueOnce(new Response('ok', { status: 200 }));
      const env = createEnv({
        DISCORD_WEBHOOK_URL: 'https://discord.test/webhook',
        SLACK_WEBHOOK_URL: 'https://slack.test/webhook',
      });
      const n = createNotification('recovery_completed');
      const result = await dispatchNotification(env, n);
      expect(result.sent).toBe(true);
      expect(result.channel).toBe('slack');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('returns error when no channels configured', async () => {
      const env = createEnv();
      const n = createNotification('budget_warning');
      const result = await dispatchNotification(env, n);
      expect(result.sent).toBe(false);
      expect(result.channel).toBe('none');
    });

    it('handles fetch error gracefully', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network timeout'));
      const env = createEnv({
        DISCORD_WEBHOOK_URL: 'https://discord.test/webhook',
        SLACK_WEBHOOK_URL: 'https://slack.test/webhook',
      });
      const n = createNotification('auto_stop');
      const result = await dispatchNotification(env, n);
      // Discord throws → falls back to Slack (which succeeds via default mock)
      expect(result.sent).toBe(true);
      expect(result.channel).toBe('slack');
    });

    it('sends to Slack only when Discord not configured', async () => {
      const env = createEnv({ SLACK_WEBHOOK_URL: 'https://slack.test/webhook' });
      const n = createNotification('heartbeat_stale');
      const result = await dispatchNotification(env, n);
      expect(result.sent).toBe(true);
      expect(result.channel).toBe('slack');
    });

    it('all results are frozen', async () => {
      const env = createEnv({ DISCORD_WEBHOOK_URL: 'https://discord.test/webhook' });
      const n = createNotification('auto_stop');
      const result = await dispatchNotification(env, n);
      expect(Object.isFrozen(result)).toBe(true);
    });
  });
});
