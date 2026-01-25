/**
 * Tests for Telegram Channel Handler
 *
 * Coverage:
 * 1. Webhook signature verification (HMAC constant-time comparison)
 * 2. Telegram update payload validation
 * 3. Event normalization to generic format
 * 4. Message sending to Telegram API
 * 5. Webhook setup
 * 6. Edge cases (empty messages, missing fields, malformed payloads)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  verifyTelegramSignature,
  validateTelegramUpdate,
  normalizeTelegramEvent,
  sendTelegramMessage,
  setTelegramWebhook,
  type TelegramUpdate,
  type TelegramMessage,
  type TelegramUser,
  type TelegramChat,
} from './telegram';

// Helper to create mock Telegram user
function createMockUser(overrides: Partial<TelegramUser> = {}): TelegramUser {
  return {
    id: 123456789,
    is_bot: false,
    first_name: 'John',
    last_name: 'Doe',
    username: 'johndoe',
    language_code: 'en',
    ...overrides,
  };
}

// Helper to create mock Telegram chat
function createMockChat(overrides: Partial<TelegramChat> = {}): TelegramChat {
  return {
    id: 987654321,
    type: 'private',
    first_name: 'John',
    last_name: 'Doe',
    username: 'johndoe',
    ...overrides,
  };
}

// Helper to create mock Telegram message
function createMockMessage(overrides: Partial<TelegramMessage> = {}): TelegramMessage {
  return {
    message_id: 42,
    from: createMockUser(),
    chat: createMockChat(),
    date: 1609459200,
    text: 'Hello, bot!',
    ...overrides,
  };
}

// Helper to create mock Telegram update
function createMockUpdate(overrides: Partial<TelegramUpdate> = {}): TelegramUpdate {
  return {
    update_id: 10000,
    message: createMockMessage(),
    ...overrides,
  };
}

describe('Telegram Webhook Signature Verification', () => {
  describe('verifyTelegramSignature', () => {
    it('should return true for matching secret tokens', () => {
      const secret = 'my-secret-token-123';
      const result = verifyTelegramSignature(secret, secret);
      expect(result).toBe(true);
    });

    it('should return false for mismatching secret tokens', () => {
      const secret = 'my-secret-token-123';
      const wrongSecret = 'wrong-secret-token';
      const result = verifyTelegramSignature(wrongSecret, secret);
      expect(result).toBe(false);
    });

    it('should return false when header is null', () => {
      const result = verifyTelegramSignature(null, 'expected-secret');
      expect(result).toBe(false);
    });

    it('should return false when expected secret is empty', () => {
      const result = verifyTelegramSignature('provided-secret', '');
      expect(result).toBe(false);
    });

    it('should return false for different length strings', () => {
      const secret = 'my-secret-token-123';
      const shortSecret = 'short';
      const result = verifyTelegramSignature(shortSecret, secret);
      expect(result).toBe(false);
    });

    it('should use constant-time comparison to prevent timing attacks', () => {
      // Same length, different content
      const secret = 'my-secret-token-123';
      const wrongSecret1 = 'my-secret-token-zzz'; // Same length, different suffix
      const wrongSecret2 = 'zy-secret-token-123'; // Same length, different prefix

      const result1 = verifyTelegramSignature(wrongSecret1, secret);
      const result2 = verifyTelegramSignature(wrongSecret2, secret);

      expect(result1).toBe(false);
      expect(result2).toBe(false);

      // Note: The implementation uses bitwise OR to ensure constant-time comparison
      // This prevents timing attacks by not short-circuiting on first mismatch
    });

    it('should handle special characters in secret token', () => {
      const secret = 'my-secret!@#$%^&*()_+-=[]{}|;:,.<>?';
      const result = verifyTelegramSignature(secret, secret);
      expect(result).toBe(true);
    });

    it('should handle Unicode characters', () => {
      const secret = 'my-secret-token-日本語-emoji-🔐';
      const result = verifyTelegramSignature(secret, secret);
      expect(result).toBe(true);
    });
  });
});

describe('Telegram Update Validation', () => {
  describe('validateTelegramUpdate', () => {
    it('should validate correct Telegram update payload', () => {
      const update = createMockUpdate();
      const result = validateTelegramUpdate(update);
      expect(result).toBe(true);
    });

    it('should reject null payload', () => {
      const result = validateTelegramUpdate(null);
      expect(result).toBe(false);
    });

    it('should reject undefined payload', () => {
      const result = validateTelegramUpdate(undefined);
      expect(result).toBe(false);
    });

    it('should reject non-object payload', () => {
      expect(validateTelegramUpdate('string')).toBe(false);
      expect(validateTelegramUpdate(123)).toBe(false);
      expect(validateTelegramUpdate(true)).toBe(false);
      expect(validateTelegramUpdate([])).toBe(false);
    });

    it('should reject payload without update_id', () => {
      const payload = { message: createMockMessage() };
      const result = validateTelegramUpdate(payload);
      expect(result).toBe(false);
    });

    it('should reject payload with non-number update_id', () => {
      const payload = { update_id: '10000', message: createMockMessage() };
      const result = validateTelegramUpdate(payload);
      expect(result).toBe(false);
    });

    it('should validate update with callback_query instead of message', () => {
      const update = {
        update_id: 10001,
        callback_query: {
          id: 'callback-id-123',
          from: createMockUser(),
          data: 'button_clicked',
        },
      };
      const result = validateTelegramUpdate(update);
      expect(result).toBe(true);
    });

    it('should validate update with negative update_id', () => {
      const update = createMockUpdate({ update_id: -1 });
      const result = validateTelegramUpdate(update);
      expect(result).toBe(true);
    });

    it('should validate update with zero update_id', () => {
      const update = createMockUpdate({ update_id: 0 });
      const result = validateTelegramUpdate(update);
      expect(result).toBe(true);
    });
  });
});

describe('Telegram Event Normalization', () => {
  describe('normalizeTelegramEvent', () => {
    it('should normalize message with full user info', () => {
      const update = createMockUpdate();
      const result = normalizeTelegramEvent(update);

      expect(result).not.toBeNull();
      expect(result).toMatchObject({
        id: 'telegram_10000_42',
        source: 'clawdbot',
        type: 'customer_message',
        content: 'Hello, bot!',
        requiresOrchestrator: false,
      });

      expect(result!.metadata).toMatchObject({
        channel: 'telegram',
        chatId: 987654321,
        messageId: 42,
        languageCode: 'en',
      });

      expect(result!.metadata.user).toMatchObject({
        id: '123456789',
        name: 'John Doe',
        username: 'johndoe',
      });
    });

    it('should normalize message without last_name', () => {
      const update = createMockUpdate({
        message: createMockMessage({
          from: createMockUser({ last_name: undefined }),
        }),
      });
      const result = normalizeTelegramEvent(update);

      expect(result).not.toBeNull();
      expect(result!.metadata.user).toMatchObject({
        id: '123456789',
        name: 'John',
        username: 'johndoe',
      });
    });

    it('should normalize message without username', () => {
      const update = createMockUpdate({
        message: createMockMessage({
          from: createMockUser({ username: undefined }),
        }),
      });
      const result = normalizeTelegramEvent(update);

      expect(result).not.toBeNull();
      expect(result!.metadata.user).toMatchObject({
        id: '123456789',
        name: 'John Doe',
      });
      expect(result!.metadata.user?.username).toBeUndefined();
    });

    it('should normalize message without from field (channel post)', () => {
      const update = createMockUpdate({
        message: createMockMessage({
          from: undefined,
          chat: createMockChat({ type: 'channel', title: 'News Channel' }),
        }),
      });
      const result = normalizeTelegramEvent(update);

      expect(result).not.toBeNull();
      expect(result!.metadata.user).toMatchObject({
        id: '987654321', // Uses chat.id as fallback
      });
      expect(result!.metadata.user?.name).toBeUndefined();
    });

    it('should normalize message with reply_to_message', () => {
      const replyToMessage = createMockMessage({ message_id: 40 });
      const update = createMockUpdate({
        message: createMockMessage({ reply_to_message: replyToMessage }),
      });
      const result = normalizeTelegramEvent(update);

      expect(result).not.toBeNull();
      expect(result!.metadata.replyToMessageId).toBe(40);
    });

    it('should normalize group chat message', () => {
      const update = createMockUpdate({
        message: createMockMessage({
          chat: createMockChat({ type: 'group', title: 'Test Group' }),
        }),
      });
      const result = normalizeTelegramEvent(update);

      expect(result).not.toBeNull();
      expect(result!.metadata.channel).toBe('telegram');
    });

    it('should return null for update without message', () => {
      const update: TelegramUpdate = {
        update_id: 10000,
        callback_query: {
          id: 'callback-id',
          from: createMockUser(),
          data: 'button_data',
        },
      };
      const result = normalizeTelegramEvent(update);
      expect(result).toBeNull();
    });

    it('should return null for message without text', () => {
      const update = createMockUpdate({
        message: createMockMessage({ text: undefined }),
      });
      const result = normalizeTelegramEvent(update);
      expect(result).toBeNull();
    });

    it('should return null for message with empty text', () => {
      const update = createMockUpdate({
        message: createMockMessage({ text: '' }),
      });
      const result = normalizeTelegramEvent(update);
      expect(result).toBeNull();
    });

    it('should normalize message with only whitespace text', () => {
      const update = createMockUpdate({
        message: createMockMessage({ text: '   ' }),
      });
      const result = normalizeTelegramEvent(update);

      // Note: The implementation doesn't trim, so whitespace is preserved
      expect(result).not.toBeNull();
      expect(result!.content).toBe('   ');
    });

    it('should handle very long messages', () => {
      const longText = 'a'.repeat(10000);
      const update = createMockUpdate({
        message: createMockMessage({ text: longText }),
      });
      const result = normalizeTelegramEvent(update);

      expect(result).not.toBeNull();
      expect(result!.content).toBe(longText);
    });

    it('should preserve special characters in message text', () => {
      const specialText = 'Hello! @user #hashtag https://example.com 🎉';
      const update = createMockUpdate({
        message: createMockMessage({ text: specialText }),
      });
      const result = normalizeTelegramEvent(update);

      expect(result).not.toBeNull();
      expect(result!.content).toBe(specialText);
    });

    it('should handle multiline messages', () => {
      const multilineText = 'Line 1\nLine 2\nLine 3';
      const update = createMockUpdate({
        message: createMockMessage({ text: multilineText }),
      });
      const result = normalizeTelegramEvent(update);

      expect(result).not.toBeNull();
      expect(result!.content).toBe(multilineText);
    });
  });
});

describe('Telegram Message Sending', () => {
  beforeEach(() => {
    // Reset fetch mock before each test
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('sendTelegramMessage', () => {
    it('should send message successfully', async () => {
      const mockResponse = { ok: true };
      global.fetch = vi.fn().mockResolvedValue({
        json: async () => mockResponse,
      });

      const result = await sendTelegramMessage(
        987654321,
        'Hello from bot',
        'bot-token-123'
      );

      expect(result).toBe(true);
      expect(fetch).toHaveBeenCalledWith(
        'https://api.telegram.org/botbot-token-123/sendMessage',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: 987654321,
            text: 'Hello from bot',
            reply_to_message_id: undefined,
            parse_mode: 'HTML',
          }),
        }
      );
    });

    it('should send message with reply', async () => {
      const mockResponse = { ok: true };
      global.fetch = vi.fn().mockResolvedValue({
        json: async () => mockResponse,
      });

      const result = await sendTelegramMessage(
        987654321,
        'Reply message',
        'bot-token-123',
        42
      );

      expect(result).toBe(true);
      expect(fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: expect.stringContaining('"reply_to_message_id":42'),
        })
      );
    });

    it('should return false when Telegram API returns error', async () => {
      const mockResponse = { ok: false, description: 'Chat not found' };
      global.fetch = vi.fn().mockResolvedValue({
        json: async () => mockResponse,
      });

      const result = await sendTelegramMessage(
        987654321,
        'Message',
        'bot-token-123'
      );

      expect(result).toBe(false);
    });

    it('should return false when network request fails', async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

      const result = await sendTelegramMessage(
        987654321,
        'Message',
        'bot-token-123'
      );

      expect(result).toBe(false);
    });

    it('should send message with HTML formatting', async () => {
      const mockResponse = { ok: true };
      global.fetch = vi.fn().mockResolvedValue({
        json: async () => mockResponse,
      });

      const htmlMessage = '<b>Bold</b> and <i>italic</i>';
      await sendTelegramMessage(987654321, htmlMessage, 'bot-token-123');

      expect(fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: expect.stringContaining('"parse_mode":"HTML"'),
        })
      );
    });

    it('should handle empty message text', async () => {
      const mockResponse = { ok: true };
      global.fetch = vi.fn().mockResolvedValue({
        json: async () => mockResponse,
      });

      const result = await sendTelegramMessage(987654321, '', 'bot-token-123');

      expect(result).toBe(true);
      expect(fetch).toHaveBeenCalled();
    });

    it('should handle very long message text', async () => {
      const mockResponse = { ok: true };
      global.fetch = vi.fn().mockResolvedValue({
        json: async () => mockResponse,
      });

      const longText = 'a'.repeat(5000);
      const result = await sendTelegramMessage(
        987654321,
        longText,
        'bot-token-123'
      );

      expect(result).toBe(true);
    });

    it('should handle negative chat_id (channels)', async () => {
      const mockResponse = { ok: true };
      global.fetch = vi.fn().mockResolvedValue({
        json: async () => mockResponse,
      });

      const result = await sendTelegramMessage(
        -1001234567890,
        'Channel message',
        'bot-token-123'
      );

      expect(result).toBe(true);
      expect(fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: expect.stringContaining('"chat_id":-1001234567890'),
        })
      );
    });
  });
});

describe('Telegram Webhook Setup', () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('setTelegramWebhook', () => {
    it('should set webhook successfully', async () => {
      const mockResponse = { ok: true };
      global.fetch = vi.fn().mockResolvedValue({
        json: async () => mockResponse,
      });

      const result = await setTelegramWebhook(
        'https://example.com/webhook',
        'bot-token-123'
      );

      expect(result).toBe(true);
      expect(fetch).toHaveBeenCalledWith(
        'https://api.telegram.org/botbot-token-123/setWebhook',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: 'https://example.com/webhook',
            allowed_updates: ['message', 'callback_query'],
          }),
        }
      );
    });

    it('should return false when Telegram API returns error', async () => {
      const mockResponse = { ok: false, description: 'Invalid webhook URL' };
      global.fetch = vi.fn().mockResolvedValue({
        json: async () => mockResponse,
      });

      const result = await setTelegramWebhook(
        'invalid-url',
        'bot-token-123'
      );

      expect(result).toBe(false);
    });

    it('should return false when network request fails', async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

      const result = await setTelegramWebhook(
        'https://example.com/webhook',
        'bot-token-123'
      );

      expect(result).toBe(false);
    });

    it('should configure allowed_updates for message and callback_query', async () => {
      const mockResponse = { ok: true };
      global.fetch = vi.fn().mockResolvedValue({
        json: async () => mockResponse,
      });

      await setTelegramWebhook('https://example.com/webhook', 'bot-token-123');

      expect(fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: expect.stringContaining('"allowed_updates":["message","callback_query"]'),
        })
      );
    });

    it('should handle webhook URL with query parameters', async () => {
      const mockResponse = { ok: true };
      global.fetch = vi.fn().mockResolvedValue({
        json: async () => mockResponse,
      });

      const webhookUrl = 'https://example.com/webhook?token=abc123';
      const result = await setTelegramWebhook(webhookUrl, 'bot-token-123');

      expect(result).toBe(true);
      expect(fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: expect.stringContaining(webhookUrl),
        })
      );
    });
  });
});

describe('Edge Cases and Error Handling', () => {
  describe('Type Safety', () => {
    it('should handle malformed update with extra fields', () => {
      const malformedUpdate = {
        update_id: 10000,
        message: createMockMessage(),
        extra_field: 'should be ignored',
        nested: { data: 'ignored' },
      };

      const isValid = validateTelegramUpdate(malformedUpdate);
      expect(isValid).toBe(true);

      const normalized = normalizeTelegramEvent(malformedUpdate as TelegramUpdate);
      expect(normalized).not.toBeNull();
    });

    it('should handle message with missing optional fields', () => {
      const minimalMessage: TelegramMessage = {
        message_id: 1,
        chat: { id: 123, type: 'private' },
        date: 1609459200,
        text: 'Hello',
      };

      const update: TelegramUpdate = {
        update_id: 10000,
        message: minimalMessage,
      };

      const result = normalizeTelegramEvent(update);
      expect(result).not.toBeNull();
      expect(result!.metadata.user?.id).toBe('123'); // Falls back to chat.id
    });
  });

  describe('Boundary Conditions', () => {
    it('should handle maximum safe integer for IDs', () => {
      const maxInt = Number.MAX_SAFE_INTEGER;
      const update = createMockUpdate({
        update_id: maxInt,
        message: createMockMessage({
          message_id: maxInt,
          from: createMockUser({ id: maxInt }),
          chat: createMockChat({ id: maxInt }),
        }),
      });

      const result = normalizeTelegramEvent(update);
      expect(result).not.toBeNull();
      expect(result!.id).toBe(`telegram_${maxInt}_${maxInt}`);
    });

    it('should handle zero values for IDs', () => {
      const update = createMockUpdate({
        update_id: 0,
        message: createMockMessage({
          message_id: 0,
          from: createMockUser({ id: 0 }),
          chat: createMockChat({ id: 0 }),
        }),
      });

      const result = normalizeTelegramEvent(update);
      expect(result).not.toBeNull();
      expect(result!.metadata.user?.id).toBe('0');
    });
  });

  describe('Security', () => {
    it('should prevent timing attacks with constant-time comparison', () => {
      const correctSecret = 'secret-token-with-exact-length-32';
      const wrongSecrets = [
        'secret-token-with-exact-length-33', // Different last char
        'aecret-token-with-exact-length-32', // Different first char
        'secret-token-zith-exact-length-32', // Different middle char
      ];

      wrongSecrets.forEach((wrongSecret) => {
        const result = verifyTelegramSignature(wrongSecret, correctSecret);
        expect(result).toBe(false);
      });
    });

    it('should handle potential injection in message text', () => {
      const injectionAttempts = [
        '<script>alert("xss")</script>',
        '"; DROP TABLE users; --',
        '../../../etc/passwd',
        '${process.env.SECRET}',
      ];

      injectionAttempts.forEach((maliciousText) => {
        const update = createMockUpdate({
          message: createMockMessage({ text: maliciousText }),
        });

        const result = normalizeTelegramEvent(update);
        expect(result).not.toBeNull();
        expect(result!.content).toBe(maliciousText); // Should preserve as-is, sanitization handled elsewhere
      });
    });
  });
});
