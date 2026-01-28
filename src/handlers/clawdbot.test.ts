/**
 * Tests for ClawdBot Handler
 *
 * Test Coverage:
 * 1. FAQ pattern detection
 * 2. Escalation trigger detection
 * 3. Message validation
 * 4. Event normalization
 * 5. FAQ prompt generation
 * 6. Response formatting
 */

import { describe, it, expect, vi } from 'vitest';
import {
  detectFAQCategory,
  requiresEscalation,
  normalizeClawdBotEvent,
  generateFAQPrompt,
  formatResponse,
  validatePayload,
  type ClawdBotMessage,
} from './clawdbot';

// Mock dependencies
vi.mock('../utils/log-sanitizer', () => ({
  safeLog: {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Helper to create mock ClawdBot messages
function createMockMessage(overrides: Partial<ClawdBotMessage> = {}): ClawdBotMessage {
  return {
    id: 'msg_123',
    channel: 'whatsapp',
    user: {
      id: 'user_123',
      name: 'John Doe',
      phone: '+1234567890',
    },
    message: 'Hello, I have a question',
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe('FAQ Pattern Detection', () => {
  it('should detect hours FAQ category', () => {
    const category = detectFAQCategory('what time are you open?');
    expect(category).toBe('hours');
  });

  it('should detect hours FAQ in Japanese', () => {
    const category = detectFAQCategory('営業時間は？');
    expect(category).toBe('hours');
  });

  it('should detect location FAQ category', () => {
    const category = detectFAQCategory('where are you located?');
    expect(category).toBe('location');
  });

  it('should detect location FAQ in Japanese', () => {
    const category = detectFAQCategory('場所はどこですか？');
    expect(category).toBe('location');
  });

  it('should detect pricing FAQ category', () => {
    const category = detectFAQCategory('price information please');
    expect(category).toBe('pricing');
  });

  it('should detect pricing FAQ in Japanese', () => {
    const category = detectFAQCategory('価格はいくらですか？');
    expect(category).toBe('pricing');
  });

  it('should detect booking FAQ category', () => {
    const category = detectFAQCategory('book an appointment');
    expect(category).toBe('booking');
  });

  it('should detect booking FAQ in Japanese', () => {
    const category = detectFAQCategory('予約したいです');
    expect(category).toBe('booking');
  });

  it('should detect cancellation FAQ category', () => {
    const category = detectFAQCategory('cancel my order');
    expect(category).toBe('cancellation');
  });

  it('should detect payment FAQ category', () => {
    const category = detectFAQCategory('payment methods?');
    expect(category).toBe('payment');
  });

  it('should detect refund FAQ category', () => {
    const category = detectFAQCategory('refund policy');
    expect(category).toBe('refund');
  });

  it('should detect shipping FAQ category', () => {
    const category = detectFAQCategory('shipping information');
    expect(category).toBe('shipping');
  });

  it('should return null for non-FAQ messages', () => {
    const category = detectFAQCategory('This is a complex question about custom integration');
    expect(category).toBeNull();
  });
});

describe('Escalation Detection', () => {
  it('should escalate complaint messages', () => {
    const result = requiresEscalation('I want to make a complaint');
    expect(result).toBe(true);
  });

  it('should escalate complaint in Japanese', () => {
    const result = requiresEscalation('クレームがあります');
    expect(result).toBe(true);
  });

  it('should escalate angry tone messages', () => {
    const result = requiresEscalation('This is unacceptable! I am very angry!');
    expect(result).toBe(true);
  });

  it('should escalate angry tone in Japanese', () => {
    const result = requiresEscalation('許せない、怒っています');
    expect(result).toBe(true);
  });

  it('should escalate urgent requests', () => {
    const result = requiresEscalation('URGENT: Need help immediately!');
    expect(result).toBe(true);
  });

  it('should escalate emergency keywords', () => {
    const result = requiresEscalation('This is an emergency');
    expect(result).toBe(true);
  });

  it('should escalate urgent requests with urgent keyword', () => {
    const result = requiresEscalation('urgent problem with payment');
    expect(result).toBe(true);
  });

  it('should not escalate normal messages', () => {
    const result = requiresEscalation('What are your opening hours?');
    expect(result).toBe(false);
  });

  it('should not escalate FAQ messages', () => {
    const result = requiresEscalation('How much does it cost?');
    expect(result).toBe(false);
  });
});

describe('Message Validation', () => {
  it('should validate valid WhatsApp message', () => {
    const validMessage = createMockMessage({
      channel: 'whatsapp',
      message: 'What are your opening hours?',
    });

    const result = validatePayload(validMessage);
    expect(result).toBe(true);
  });

  it('should validate valid Telegram message', () => {
    const validMessage = createMockMessage({
      channel: 'telegram',
      message: 'How much does it cost?',
    });

    const result = validatePayload(validMessage);
    expect(result).toBe(true);
  });

  it('should validate valid web message', () => {
    const validMessage = createMockMessage({
      channel: 'web',
      message: 'I need help',
    });

    const result = validatePayload(validMessage);
    expect(result).toBe(true);
  });

  it('should reject message without required fields', () => {
    const invalidMessage = {
      id: 'msg_123',
      // Missing required fields
    };

    const result = validatePayload(invalidMessage);
    expect(result).toBe(false);
  });

  it('should reject message with invalid channel', () => {
    const invalidMessage = createMockMessage({
      channel: 'invalid-channel' as any,
    });

    const result = validatePayload(invalidMessage);
    expect(result).toBe(false);
  });
});

describe('Event Normalization', () => {
  it('should normalize WhatsApp FAQ message', () => {
    const message = createMockMessage({
      channel: 'whatsapp',
      message: 'what time are you open?',
    });

    const normalized = normalizeClawdBotEvent(message);

    expect(normalized.type).toBe('faq');
    expect(normalized.content).toBe('what time are you open?');
    expect(normalized.source).toBe('clawdbot');
    expect(normalized.metadata?.faqCategory).toBe('hours');
  });

  it('should normalize escalation message', () => {
    const message = createMockMessage({
      channel: 'telegram',
      message: 'I have a complaint!',
    });

    const normalized = normalizeClawdBotEvent(message);

    expect(normalized.type).toBe('escalation');
    expect(normalized.content).toBe('I have a complaint!');
    expect(normalized.metadata?.needsEscalation).toBe(true);
  });

  it('should normalize customer message without FAQ category', () => {
    const message = createMockMessage({
      message: 'I need help with a custom integration',
    });

    const normalized = normalizeClawdBotEvent(message);

    expect(normalized.type).toBe('customer_message');
    expect(normalized.content).toBe('I need help with a custom integration');
    expect(normalized.metadata?.faqCategory).toBeNull();
  });

  it('should include user metadata', () => {
    const message = createMockMessage({
      user: {
        id: 'user_456',
        name: 'Jane Smith',
        phone: '+9876543210',
      },
    });

    const normalized = normalizeClawdBotEvent(message);

    expect(normalized.metadata?.user.id).toBe('user_456');
    expect(normalized.metadata?.user.name).toBe('Jane Smith');
    expect(normalized.metadata?.user.phone).toBe('+9876543210');
  });

  it('should include thread information', () => {
    const message = createMockMessage({
      replyTo: 'msg_parent_123',
    });

    const normalized = normalizeClawdBotEvent(message);

    expect(normalized.metadata?.replyTo).toBe('msg_parent_123');
  });
});

describe('FAQ Prompt Generation', () => {
  it('should generate prompt for hours category', () => {
    const prompt = generateFAQPrompt('hours', 'What time are you open?');

    expect(prompt).toContain('営業時間'); // Japanese prompt
    expect(prompt).toContain('What time are you open?');
  });

  it('should generate prompt for location category', () => {
    const prompt = generateFAQPrompt('location', 'Where are you located?');

    expect(prompt).toContain('場所'); // Japanese prompt
    expect(prompt).toContain('Where are you located?');
  });

  it('should generate prompt for pricing category', () => {
    const prompt = generateFAQPrompt('pricing', 'How much does it cost?');

    expect(prompt).toContain('価格'); // Japanese prompt
    expect(prompt).toContain('How much does it cost?');
  });

  it('should include message in prompt', () => {
    const category = 'booking';
    const message = 'I want to book an appointment';

    const prompt = generateFAQPrompt(category, message);

    expect(prompt).toContain(message);
    expect(prompt).toContain('予約'); // Japanese for booking
  });
});

describe('Response Formatting', () => {
  it('should format WhatsApp response with bold markdown', () => {
    const formatted = formatResponse('whatsapp', 'We are **open** from 9am to 5pm');

    expect(formatted).toBe('We are *open* from 9am to 5pm');
  });

  it('should format Telegram response with HTML bold', () => {
    const formatted = formatResponse('telegram', 'We are **open** from 9am to 5pm');

    expect(formatted).toBe('We are <b>open</b> from 9am to 5pm');
  });

  it('should return plain text for web channel', () => {
    const formatted = formatResponse('web', 'We are **open** from 9am to 5pm');

    expect(formatted).toBe('We are **open** from 9am to 5pm');
  });

  it('should handle multiple bold markers in WhatsApp', () => {
    const formatted = formatResponse('whatsapp', '**Price**: $99, **Hours**: 9-5');

    expect(formatted).toBe('*Price*: $99, *Hours*: 9-5');
  });

  it('should handle multiple bold markers in Telegram', () => {
    const formatted = formatResponse('telegram', '**Price**: $99, **Hours**: 9-5');

    expect(formatted).toBe('<b>Price</b>: $99, <b>Hours</b>: 9-5');
  });
});

describe('Edge Cases', () => {
  it('should handle empty message', () => {
    const category = detectFAQCategory('');
    expect(category).toBeNull();
  });

  it('should handle message with only whitespace', () => {
    const category = detectFAQCategory('   ');
    expect(category).toBeNull();
  });

  it('should handle very long message', () => {
    const longMessage = 'a'.repeat(1000);
    const category = detectFAQCategory(longMessage);
    expect(category).toBeNull();
  });

  it('should handle mixed language message', () => {
    const category = detectFAQCategory('営業時間 is what?');
    expect(category).toBe('hours');
  });

  it('should handle case-insensitive matching', () => {
    const category1 = detectFAQCategory('OPENING HOURS');
    const category2 = detectFAQCategory('opening hours');
    const category3 = detectFAQCategory('Opening Hours');

    expect(category1).toBe('hours');
    expect(category2).toBe('hours');
    expect(category3).toBe('hours');
  });
});
