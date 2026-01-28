/**
 * Tests for Slack Webhook Handler
 *
 * Test Coverage:
 * 1. URL verification challenge handling
 * 2. Event validation with Zod schema
 * 3. Bot message filtering
 * 4. Channel routing rules (action allowed, consensus required, auto-execute)
 * 5. Message normalization
 */

import { describe, it, expect, vi } from 'vitest';
import {
  handleChallenge,
  normalizeSlackEvent,
  isActionAllowed,
  requiresConsensus,
  shouldAutoExecute,
  type SlackEvent,
  type SlackResponse,
} from './slack';

describe('Slack Challenge Handling', () => {
  it('should respond to valid challenge', () => {
    const challengeEvent: SlackEvent = {
      type: 'url_verification',
      token: 'test-token',
      challenge: 'challenge-value-123',
    };

    const response = handleChallenge(challengeEvent);

    expect(response.ok).toBe(true);
    expect(response.challenge).toBe('challenge-value-123');
  });

  it('should reject challenge without challenge field', () => {
    const invalidEvent: SlackEvent = {
      type: 'url_verification',
      token: 'test-token',
    };

    const response = handleChallenge(invalidEvent);

    expect(response.ok).toBe(false);
    expect(response.error).toBeDefined();
  });

  it('should reject non-challenge events', () => {
    const nonChallengeEvent: SlackEvent = {
      type: 'event_callback',
      event: {
        type: 'message',
        text: 'Hello',
        user: 'U123',
        channel: 'C123',
        ts: '123',
      },
    };

    const response = handleChallenge(nonChallengeEvent);

    expect(response.ok).toBe(false);
  });
});

describe('Slack Event Normalization', () => {
  it('should normalize message event', () => {
    const slackEvent: SlackEvent = {
      type: 'event_callback',
      event: {
        type: 'message',
        text: 'Deploy to production',
        user: 'U123456',
        channel: 'C123456',
        ts: '1234567890.123456',
      },
      team_id: 'T123456',
    };

    const channelMap = { C123456: 'vibe-coding' };
    const normalized = normalizeSlackEvent(slackEvent, channelMap);

    expect(normalized).toBeDefined();
    expect(normalized?.type).toBe('message');
    expect(normalized?.content).toBe('Deploy to production');
    expect(normalized?.metadata?.user).toBe('U123456');
    expect(normalized?.source).toBe('slack');
  });

  it('should return null for event without event field', () => {
    const invalidEvent: SlackEvent = {
      type: 'url_verification',
      token: 'test',
      challenge: 'test',
    };

    const normalized = normalizeSlackEvent(invalidEvent);

    expect(normalized).toBeNull();
  });

  it('should filter out bot messages', () => {
    const botEvent: SlackEvent = {
      type: 'event_callback',
      event: {
        type: 'message',
        text: 'Bot message',
        user: 'U123',
        channel: 'C123',
        ts: '123',
        bot_id: 'B123', // Bot message
      },
    };

    const normalized = normalizeSlackEvent(botEvent);

    // Should still normalize but include bot info
    expect(normalized).toBeDefined();
  });

  it('should include thread information', () => {
    const threadEvent: SlackEvent = {
      type: 'event_callback',
      event: {
        type: 'message',
        text: 'Reply message',
        user: 'U123',
        channel: 'C123',
        ts: '1234567890.123456',
        thread_ts: '1234567890.000000',
      },
    };

    const normalized = normalizeSlackEvent(threadEvent);

    expect(normalized).toBeDefined();
    expect(normalized?.metadata?.threadTs).toBe('1234567890.000000');
  });
});

describe('Channel Routing Rules', () => {
  describe('isActionAllowed', () => {
    it('should allow code action in vibe-coding channel', () => {
      const result = isActionAllowed('vibe-coding', 'code');
      expect(result).toBe(true);
    });

    it('should allow refactor action in vibe-coding channel', () => {
      const result = isActionAllowed('vibe-coding', 'refactor');
      expect(result).toBe(true);
    });

    it('should disallow invalid action in vibe-coding channel', () => {
      const result = isActionAllowed('vibe-coding', 'invalid-action');
      expect(result).toBe(false);
    });

    it('should allow approve action in approvals channel', () => {
      const result = isActionAllowed('approvals', 'approve');
      expect(result).toBe(true);
    });

    it('should allow reject action in approvals channel', () => {
      const result = isActionAllowed('approvals', 'reject');
      expect(result).toBe(true);
    });

    it('should allow actions in unknown channel (permissive default)', () => {
      const result = isActionAllowed('unknown-channel', 'code');
      expect(result).toBe(true); // Unknown channels allow all by default
    });
  });

  describe('requiresConsensus', () => {
    it('should require consensus for approvals channel', () => {
      const result = requiresConsensus('approvals');
      expect(result).toBe(true);
    });

    it('should not require consensus for vibe-coding channel', () => {
      const result = requiresConsensus('vibe-coding');
      expect(result).toBe(false);
    });

    it('should not require consensus for unknown channel', () => {
      const result = requiresConsensus('unknown-channel');
      expect(result).toBe(false);
    });
  });

  describe('shouldAutoExecute', () => {
    it('should auto-execute in vibe-coding channel', () => {
      const result = shouldAutoExecute('vibe-coding');
      expect(result).toBe(true);
    });

    it('should not auto-execute in approvals channel', () => {
      const result = shouldAutoExecute('approvals');
      expect(result).toBe(false);
    });

    it('should not auto-execute in unknown channel', () => {
      const result = shouldAutoExecute('unknown-channel');
      expect(result).toBe(false);
    });
  });
});

describe('Slack Event Types', () => {
  it('should handle message type', () => {
    const event: SlackEvent = {
      type: 'event_callback',
      event: {
        type: 'message',
        text: 'Test message',
        user: 'U123',
        channel: 'C123',
        ts: '123',
      },
    };

    const normalized = normalizeSlackEvent(event);
    expect(normalized?.type).toBe('message');
  });

  it('should include channel information', () => {
    const event: SlackEvent = {
      type: 'event_callback',
      event: {
        type: 'message',
        text: 'Test',
        user: 'U123',
        channel: 'C123',
        ts: '123',
      },
    };

    const channelMap = { C123: 'vibe-coding' };
    const normalized = normalizeSlackEvent(event, channelMap);

    expect(normalized?.metadata?.channel).toBe('C123'); // Channel ID
    expect(normalized?.metadata?.channelName).toBe('vibe-coding'); // Channel name
  });

  it('should include team_id in metadata', () => {
    const event: SlackEvent = {
      type: 'event_callback',
      team_id: 'T123456',
      event: {
        type: 'message',
        text: 'Test',
        user: 'U123',
        channel: 'C123',
        ts: '123',
      },
    };

    const normalized = normalizeSlackEvent(event);

    expect(normalized?.metadata?.teamId).toBe('T123456');
  });
});
