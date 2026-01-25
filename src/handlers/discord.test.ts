/**
 * Tests for Discord Webhook Handler
 *
 * Test Coverage:
 * 1. Valid Discord interaction parsing
 * 2. Ed25519 signature verification
 * 3. Ping/Pong handling
 * 4. Slash command handling
 * 5. Message normalization to generic event format
 * 6. Error handling paths
 * 7. Channel routing rules
 * 8. Action permissions
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  verifyDiscordSignature,
  handlePing,
  isPing,
  normalizeDiscordEvent,
  createDeferredResponse,
  createMessageResponse,
  isActionAllowed,
  requiresConsensus,
  type DiscordInteraction,
  type DiscordResponse,
} from './discord';

// Store original crypto
const originalCrypto = globalThis.crypto;

// Helper to create mock Discord interactions
function createMockInteraction(
  overrides: Partial<DiscordInteraction> = {}
): DiscordInteraction {
  return {
    type: 2, // APPLICATION_COMMAND by default
    id: 'interaction_123',
    application_id: 'app_123',
    token: 'interaction_token',
    ...overrides,
  };
}

describe('Discord Interaction Parsing', () => {
  describe('isPing', () => {
    it('should return true for PING interactions', () => {
      const pingInteraction = createMockInteraction({ type: 1 });
      expect(isPing(pingInteraction)).toBe(true);
    });

    it('should return false for APPLICATION_COMMAND interactions', () => {
      const commandInteraction = createMockInteraction({ type: 2 });
      expect(isPing(commandInteraction)).toBe(false);
    });

    it('should return false for MESSAGE_COMPONENT interactions', () => {
      const componentInteraction = createMockInteraction({ type: 3 });
      expect(isPing(componentInteraction)).toBe(false);
    });
  });

  describe('handlePing', () => {
    it('should return PONG response', () => {
      const response = handlePing();
      expect(response).toEqual({ type: 1 }); // InteractionResponseType.PONG
    });

    it('should not include data in PONG response', () => {
      const response = handlePing();
      expect(response.data).toBeUndefined();
    });
  });
});

describe('Ed25519 Signature Verification', () => {
  const mockImportKey = vi.fn();
  const mockVerify = vi.fn();

  beforeEach(() => {
    // Reset mocks
    vi.clearAllMocks();

    // Mock crypto.subtle methods using vi.spyOn
    vi.spyOn(globalThis.crypto.subtle, 'importKey').mockImplementation(mockImportKey);
    vi.spyOn(globalThis.crypto.subtle, 'verify').mockImplementation(mockVerify);
  });

  afterEach(() => {
    // Restore mocks
    vi.restoreAllMocks();
  });

  it('should return false when signature is null', async () => {
    const result = await verifyDiscordSignature(
      null,
      '1234567890',
      '{"type":1}',
      'abc123'
    );
    expect(result).toBe(false);
  });

  it('should return false when timestamp is null', async () => {
    const result = await verifyDiscordSignature(
      'signature',
      null,
      '{"type":1}',
      'abc123'
    );
    expect(result).toBe(false);
  });

  it('should return false when publicKey is empty', async () => {
    const result = await verifyDiscordSignature(
      'signature',
      '1234567890',
      '{"type":1}',
      ''
    );
    expect(result).toBe(false);
  });

  it('should verify valid signature', async () => {
    const validSignature = 'a'.repeat(128); // 64 bytes hex
    const timestamp = '1234567890';
    const body = '{"type":1}';
    const publicKey = 'b'.repeat(64); // 32 bytes hex

    // Mock successful verification
    mockImportKey.mockResolvedValue({} as CryptoKey);
    mockVerify.mockResolvedValue(true);

    const result = await verifyDiscordSignature(
      validSignature,
      timestamp,
      body,
      publicKey
    );

    expect(result).toBe(true);
    expect(mockImportKey).toHaveBeenCalledWith(
      'raw',
      expect.any(Uint8Array),
      {
        name: 'NODE-ED25519',
        namedCurve: 'NODE-ED25519',
      },
      true,
      ['verify']
    );
    expect(mockVerify).toHaveBeenCalledWith(
      'NODE-ED25519',
      expect.anything(),
      expect.any(Uint8Array),
      expect.any(Uint8Array)
    );
  });

  it('should reject invalid signature', async () => {
    const invalidSignature = 'a'.repeat(128);
    const timestamp = '1234567890';
    const body = '{"type":1}';
    const publicKey = 'b'.repeat(64);

    // Mock failed verification
    mockImportKey.mockResolvedValue({} as CryptoKey);
    mockVerify.mockResolvedValue(false);

    const result = await verifyDiscordSignature(
      invalidSignature,
      timestamp,
      body,
      publicKey
    );

    expect(result).toBe(false);
  });

  it('should handle verification errors gracefully', async () => {
    const signature = 'a'.repeat(128);
    const timestamp = '1234567890';
    const body = '{"type":1}';
    const publicKey = 'b'.repeat(64);

    // Mock crypto error
    mockImportKey.mockRejectedValue(new Error('Crypto error'));

    const result = await verifyDiscordSignature(
      signature,
      timestamp,
      body,
      publicKey
    );

    expect(result).toBe(false);
  });

  it('should concatenate timestamp and body correctly', async () => {
    const signature = 'a'.repeat(128);
    const timestamp = '1234567890';
    const body = '{"type":1}';
    const publicKey = 'b'.repeat(64);

    mockImportKey.mockResolvedValue({} as CryptoKey);
    mockVerify.mockResolvedValue(true);

    await verifyDiscordSignature(signature, timestamp, body, publicKey);

    // Verify message is timestamp + body
    const expectedMessage = new TextEncoder().encode(timestamp + body);
    expect(mockVerify).toHaveBeenCalledWith(
      'NODE-ED25519',
      expect.anything(),
      expect.any(Uint8Array),
      expect.objectContaining({
        0: expectedMessage[0],
        length: expectedMessage.length,
      })
    );
  });
});

describe('Slash Command Handling', () => {
  describe('normalizeDiscordEvent', () => {
    it('should return null for PING interactions', () => {
      const pingInteraction = createMockInteraction({ type: 1 });
      const result = normalizeDiscordEvent(pingInteraction);
      expect(result).toBeNull();
    });

    it('should normalize slash command to NormalizedEvent', () => {
      const commandInteraction = createMockInteraction({
        type: 2, // APPLICATION_COMMAND
        data: {
          id: 'cmd_123',
          name: 'review',
          options: [
            { name: 'file', type: 3, value: 'src/main.ts' },
            { name: 'type', type: 3, value: 'security' },
          ],
        },
        channel_id: 'ch_123',
        guild_id: 'guild_123',
        member: {
          user: {
            id: 'user_123',
            username: 'testuser',
          },
        },
      });

      const channelMap = { ch_123: 'vibe-coding' };
      const result = normalizeDiscordEvent(commandInteraction, channelMap);

      expect(result).toEqual({
        id: 'discord_interaction_123',
        source: 'discord',
        type: 'command',
        content: '/review file:src/main.ts type:security',
        metadata: {
          user: 'user_123',
          username: 'testuser',
          channel: 'ch_123',
          channelName: 'vibe-coding',
          guildId: 'guild_123',
          interactionToken: 'interaction_token',
          rule: {
            autoExecute: true,
            requiresConsensus: undefined,
            delegateTo: 'codex',
          },
        },
        requiresOrchestrator: true,
      });
    });

    it('should handle slash command without options', () => {
      const commandInteraction = createMockInteraction({
        type: 2,
        data: {
          id: 'cmd_123',
          name: 'help',
        },
        channel_id: 'ch_123',
      });

      const result = normalizeDiscordEvent(commandInteraction);

      expect(result?.content).toBe('/help');
      expect(result?.type).toBe('command');
    });

    it('should handle MESSAGE_COMPONENT interactions', () => {
      const componentInteraction = createMockInteraction({
        type: 3, // MESSAGE_COMPONENT
        message: {
          id: 'msg_123',
          content: 'Button clicked',
        },
        channel_id: 'ch_123',
      });

      const result = normalizeDiscordEvent(componentInteraction);

      expect(result?.content).toBe('Button clicked');
      expect(result?.type).toBe('interaction');
    });

    it('should use channel map to resolve channel name', () => {
      const commandInteraction = createMockInteraction({
        type: 2,
        channel_id: 'ch_456',
      });

      const channelMap = {
        ch_456: 'approvals',
      };

      const result = normalizeDiscordEvent(commandInteraction, channelMap);

      expect(result?.metadata.channelName).toBe('approvals');
    });

    it('should default to "unknown" for unmapped channels', () => {
      const commandInteraction = createMockInteraction({
        type: 2,
        channel_id: 'ch_999',
      });

      const result = normalizeDiscordEvent(commandInteraction);

      expect(result?.metadata.channelName).toBe('unknown');
    });

    it('should set requiresOrchestrator to false for notification-only channels', () => {
      const commandInteraction = createMockInteraction({
        type: 2,
        channel_id: 'ch_alerts',
      });

      const channelMap = { ch_alerts: 'alerts' };
      const result = normalizeDiscordEvent(commandInteraction, channelMap);

      expect(result?.requiresOrchestrator).toBe(false);
    });

    it('should set requiresOrchestrator to true for normal channels', () => {
      const commandInteraction = createMockInteraction({
        type: 2,
        channel_id: 'ch_123',
      });

      const channelMap = { ch_123: 'vibe-coding' };
      const result = normalizeDiscordEvent(commandInteraction, channelMap);

      expect(result?.requiresOrchestrator).toBe(true);
    });

    it('should handle missing member data', () => {
      const commandInteraction = createMockInteraction({
        type: 2,
        channel_id: 'ch_123',
        // member is undefined
      });

      const result = normalizeDiscordEvent(commandInteraction);

      expect(result?.metadata.user).toBeUndefined();
      expect(result?.metadata.username).toBeUndefined();
    });

    it('should generate unique event ID with discord prefix', () => {
      const commandInteraction = createMockInteraction({
        type: 2,
        id: 'unique_interaction_id',
      });

      const result = normalizeDiscordEvent(commandInteraction);

      expect(result?.id).toBe('discord_unique_interaction_id');
    });
  });
});

describe('Message Normalization', () => {
  it('should handle empty content gracefully', () => {
    const interaction = createMockInteraction({
      type: 2,
      // No data or message
    });

    const result = normalizeDiscordEvent(interaction);

    expect(result?.content).toBe('');
  });

  it('should prioritize slash command over message content', () => {
    const interaction = createMockInteraction({
      type: 2,
      data: {
        id: 'cmd_123',
        name: 'test',
      },
      message: {
        id: 'msg_123',
        content: 'This should be ignored',
      },
    });

    const result = normalizeDiscordEvent(interaction);

    expect(result?.content).toBe('/test');
  });

  it('should trim whitespace from command content', () => {
    const interaction = createMockInteraction({
      type: 2,
      data: {
        id: 'cmd_123',
        name: 'review',
        options: [],
      },
    });

    const result = normalizeDiscordEvent(interaction);

    expect(result?.content).toBe('/review');
    expect(result?.content).not.toContain('  ');
  });
});

describe('Response Creation', () => {
  describe('createDeferredResponse', () => {
    it('should create deferred response', () => {
      const response = createDeferredResponse();
      expect(response).toEqual({
        type: 5, // DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
      });
    });
  });

  describe('createMessageResponse', () => {
    it('should create public message response', () => {
      const response = createMessageResponse('Hello, World!', false);
      expect(response).toEqual({
        type: 4, // CHANNEL_MESSAGE_WITH_SOURCE
        data: {
          content: 'Hello, World!',
          flags: undefined,
        },
      });
    });

    it('should create ephemeral message response', () => {
      const response = createMessageResponse('Private message', true);
      expect(response).toEqual({
        type: 4,
        data: {
          content: 'Private message',
          flags: 64, // Ephemeral flag
        },
      });
    });

    it('should default to public message when ephemeral not specified', () => {
      const response = createMessageResponse('Default message');
      expect(response.data?.flags).toBeUndefined();
    });
  });
});

describe('Channel Routing Rules', () => {
  describe('isActionAllowed', () => {
    it('should allow all actions in vibe-coding channel', () => {
      expect(isActionAllowed('vibe-coding', 'code')).toBe(true);
      expect(isActionAllowed('vibe-coding', 'refactor')).toBe(true);
      expect(isActionAllowed('vibe-coding', 'review')).toBe(true);
      expect(isActionAllowed('vibe-coding', 'test')).toBe(true);
    });

    it('should disallow actions not in allowedActions list', () => {
      expect(isActionAllowed('vibe-coding', 'delete')).toBe(false);
      expect(isActionAllowed('vibe-coding', 'deploy')).toBe(false);
    });

    it('should allow specific actions in approvals channel', () => {
      expect(isActionAllowed('approvals', 'approve')).toBe(true);
      expect(isActionAllowed('approvals', 'reject')).toBe(true);
      expect(isActionAllowed('approvals', 'review')).toBe(true);
    });

    it('should disallow all actions in notification-only channels', () => {
      expect(isActionAllowed('alerts', 'any-action')).toBe(false);
      expect(isActionAllowed('alerts', 'approve')).toBe(false);
    });

    it('should allow all actions in unknown channels', () => {
      expect(isActionAllowed('unknown-channel', 'any-action')).toBe(true);
      expect(isActionAllowed('random', 'test')).toBe(true);
    });
  });

  describe('requiresConsensus', () => {
    it('should return true for approvals channel', () => {
      expect(requiresConsensus('approvals')).toBe(true);
    });

    it('should return false for vibe-coding channel', () => {
      expect(requiresConsensus('vibe-coding')).toBe(false);
    });

    it('should return false for alerts channel', () => {
      expect(requiresConsensus('alerts')).toBe(false);
    });

    it('should return false for unknown channels', () => {
      expect(requiresConsensus('unknown-channel')).toBe(false);
    });
  });
});

describe('Error Handling', () => {
  it('should handle malformed interaction data gracefully', () => {
    const malformedInteraction = {
      // Missing required fields
      type: 2,
    } as unknown as DiscordInteraction;

    const result = normalizeDiscordEvent(malformedInteraction);

    expect(result).toBeDefined();
    expect(result?.id).toBe('discord_undefined');
    expect(result?.source).toBe('discord');
  });

  it('should handle null channel map gracefully', () => {
    const interaction = createMockInteraction({
      type: 2,
      channel_id: 'ch_123',
    });

    const result = normalizeDiscordEvent(interaction, undefined);

    expect(result?.metadata.channelName).toBe('unknown');
  });

  it('should handle interaction with no channel_id', () => {
    const interaction = createMockInteraction({
      type: 2,
      // channel_id is undefined
    });

    const result = normalizeDiscordEvent(interaction);

    expect(result?.metadata.channel).toBe('');
    expect(result?.metadata.channelName).toBe('unknown');
  });

  it('should not crash on invalid option format', () => {
    const interaction = createMockInteraction({
      type: 2,
      data: {
        id: 'cmd_123',
        name: 'test',
        options: [
          // @ts-expect-error Testing invalid data
          { invalid: 'format' },
        ],
      },
    });

    const result = normalizeDiscordEvent(interaction);

    expect(result).toBeDefined();
    expect(result?.content).toContain('/test');
  });
});

describe('Integration Tests', () => {
  it('should handle complete workflow: PING -> PONG', () => {
    const pingInteraction = createMockInteraction({ type: 1 });

    expect(isPing(pingInteraction)).toBe(true);
    const response = handlePing();
    expect(response.type).toBe(1);
  });

  it('should handle complete workflow: Slash Command -> Normalize -> Route', () => {
    const commandInteraction = createMockInteraction({
      type: 2,
      data: {
        id: 'cmd_123',
        name: 'review',
        options: [{ name: 'file', type: 3, value: 'src/index.ts' }],
      },
      channel_id: 'ch_vibe',
      member: {
        user: {
          id: 'user_123',
          username: 'developer',
        },
      },
    });

    const channelMap = { ch_vibe: 'vibe-coding' };

    // Step 1: Normalize
    const event = normalizeDiscordEvent(commandInteraction, channelMap);
    expect(event).toBeDefined();
    expect(event?.type).toBe('command');

    // Step 2: Check routing
    expect(isActionAllowed('vibe-coding', 'review')).toBe(true);
    expect(requiresConsensus('vibe-coding')).toBe(false);

    // Step 3: Create deferred response
    const deferredResponse = createDeferredResponse();
    expect(deferredResponse.type).toBe(5);

    // Step 4: Create final response
    const finalResponse = createMessageResponse('Review completed!');
    expect(finalResponse.type).toBe(4);
    expect(finalResponse.data?.content).toBe('Review completed!');
  });

  it('should handle approval workflow requiring consensus', () => {
    const approvalInteraction = createMockInteraction({
      type: 2,
      data: {
        id: 'cmd_123',
        name: 'approve',
      },
      channel_id: 'ch_approvals',
    });

    const channelMap = { ch_approvals: 'approvals' };

    const event = normalizeDiscordEvent(approvalInteraction, channelMap);
    const rule = event?.metadata.rule as { requiresConsensus?: boolean } | undefined;
    expect(rule?.requiresConsensus).toBe(true);
    expect(requiresConsensus('approvals')).toBe(true);
    expect(isActionAllowed('approvals', 'approve')).toBe(true);
  });

  it('should reject actions in notification-only channels', () => {
    const interaction = createMockInteraction({
      type: 2,
      channel_id: 'ch_alerts',
    });

    const channelMap = { ch_alerts: 'alerts' };
    const event = normalizeDiscordEvent(interaction, channelMap);

    expect(event?.requiresOrchestrator).toBe(false);
    expect(isActionAllowed('alerts', 'any-action')).toBe(false);
  });
});
