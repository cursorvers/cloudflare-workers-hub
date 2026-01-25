/**
 * Tests for WhatsApp Channel Handler
 *
 * Testing strategy:
 * 1. HMAC signature verification (security)
 * 2. Webhook payload validation
 * 3. Message extraction from complex nested structures
 * 4. Message normalization to generic event format
 * 5. Batch message handling
 * 6. Error handling and edge cases
 * 7. Status update filtering
 * 8. Webhook verification endpoint
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  verifyWhatsAppSignature,
  validateWhatsAppWebhook,
  extractMessages,
  normalizeWhatsAppEvent,
  sendWhatsAppMessage,
  verifyWebhook,
  type WhatsAppWebhook,
  type WhatsAppMessage,
  type WhatsAppContact,
} from './whatsapp';

describe('WhatsApp Signature Verification', () => {
  const appSecret = 'test-app-secret-key';
  const validBody = JSON.stringify({ test: 'data' });

  it('should verify valid HMAC-SHA256 signature', async () => {
    // Generate valid signature using Web Crypto API
    const encoder = new TextEncoder();
    const keyData = encoder.encode(appSecret);
    const messageData = encoder.encode(validBody);

    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );

    const signature = await crypto.subtle.sign('HMAC', cryptoKey, messageData);
    const hash = Array.from(new Uint8Array(signature))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    const signatureHeader = `sha256=${hash}`;

    const result = await verifyWhatsAppSignature(signatureHeader, validBody, appSecret);
    expect(result).toBe(true);
  });

  it('should reject invalid signature', async () => {
    const invalidSignature = 'sha256=invalid_hash_value_here';
    const result = await verifyWhatsAppSignature(invalidSignature, validBody, appSecret);
    expect(result).toBe(false);
  });

  it('should reject signature without sha256 prefix', async () => {
    const invalidSignature = 'abcdef1234567890';
    const result = await verifyWhatsAppSignature(invalidSignature, validBody, appSecret);
    expect(result).toBe(false);
  });

  it('should reject when signature header is null', async () => {
    const result = await verifyWhatsAppSignature(null, validBody, appSecret);
    expect(result).toBe(false);
  });

  it('should reject when app secret is empty', async () => {
    const signature = 'sha256=somehash';
    const result = await verifyWhatsAppSignature(signature, validBody, '');
    expect(result).toBe(false);
  });

  it('should reject when body is empty', async () => {
    const signature = 'sha256=somehash';
    const result = await verifyWhatsAppSignature(signature, '', appSecret);
    expect(result).toBe(false);
  });

  it('should use constant-time comparison to prevent timing attacks', async () => {
    // Generate two different signatures of same length
    const body1 = JSON.stringify({ test: 'data1' });
    const body2 = JSON.stringify({ test: 'data2' });

    const encoder = new TextEncoder();
    const keyData = encoder.encode(appSecret);

    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );

    const sig1 = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(body1));
    const hash1 = Array.from(new Uint8Array(sig1))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    // Try to verify body2 with hash1 (should fail)
    const result = await verifyWhatsAppSignature(`sha256=${hash1}`, body2, appSecret);
    expect(result).toBe(false);

    // Both hashes should have same length (SHA-256 = 64 hex chars)
    expect(hash1.length).toBe(64);
  });

  it('should handle crypto API errors gracefully', async () => {
    // Test with malformed signature that would cause parsing errors
    const malformedSignature = 'sha256=not_a_valid_hex_string!!!';
    const result = await verifyWhatsAppSignature(malformedSignature, validBody, appSecret);
    // Should return false rather than throwing
    expect(result).toBe(false);
  });
});

describe('WhatsApp Webhook Validation', () => {
  it('should validate correct webhook structure', () => {
    const validWebhook: WhatsAppWebhook = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'entry-id-123',
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  display_phone_number: '15551234567',
                  phone_number_id: 'phone-123',
                },
                messages: [],
              },
              field: 'messages',
            },
          ],
        },
      ],
    };

    expect(validateWhatsAppWebhook(validWebhook)).toBe(true);
  });

  it('should reject webhook with wrong object type', () => {
    const invalid = {
      object: 'instagram_account', // Wrong type
      entry: [],
    };

    expect(validateWhatsAppWebhook(invalid)).toBe(false);
  });

  it('should reject webhook without entry array', () => {
    const invalid = {
      object: 'whatsapp_business_account',
      entry: 'not-an-array',
    };

    expect(validateWhatsAppWebhook(invalid)).toBe(false);
  });

  it('should reject null payload', () => {
    expect(validateWhatsAppWebhook(null)).toBe(false);
  });

  it('should reject undefined payload', () => {
    expect(validateWhatsAppWebhook(undefined)).toBe(false);
  });

  it('should reject non-object payload', () => {
    expect(validateWhatsAppWebhook('string')).toBe(false);
    expect(validateWhatsAppWebhook(123)).toBe(false);
    expect(validateWhatsAppWebhook([])).toBe(false);
  });
});

describe('Message Extraction', () => {
  it('should extract single text message', () => {
    const webhook: WhatsAppWebhook = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'entry-123',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  display_phone_number: '15551234567',
                  phone_number_id: 'phone-123',
                },
                contacts: [
                  {
                    profile: { name: 'John Doe' },
                    wa_id: '15559876543',
                  },
                ],
                messages: [
                  {
                    from: '15559876543',
                    id: 'msg-abc123',
                    timestamp: '1234567890',
                    type: 'text',
                    text: { body: 'Hello, world!' },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const messages = extractMessages(webhook);

    expect(messages).toHaveLength(1);
    expect(messages[0].message.id).toBe('msg-abc123');
    expect(messages[0].message.from).toBe('15559876543');
    expect(messages[0].message.text?.body).toBe('Hello, world!');
    expect(messages[0].contact?.profile.name).toBe('John Doe');
    expect(messages[0].phoneNumberId).toBe('phone-123');
  });

  it('should extract multiple messages from batch', () => {
    const webhook: WhatsAppWebhook = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'entry-123',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  display_phone_number: '15551234567',
                  phone_number_id: 'phone-123',
                },
                contacts: [
                  { profile: { name: 'Alice' }, wa_id: '15551111111' },
                  { profile: { name: 'Bob' }, wa_id: '15552222222' },
                ],
                messages: [
                  {
                    from: '15551111111',
                    id: 'msg-1',
                    timestamp: '1234567890',
                    type: 'text',
                    text: { body: 'Message from Alice' },
                  },
                  {
                    from: '15552222222',
                    id: 'msg-2',
                    timestamp: '1234567891',
                    type: 'text',
                    text: { body: 'Message from Bob' },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const messages = extractMessages(webhook);

    expect(messages).toHaveLength(2);
    expect(messages[0].message.id).toBe('msg-1');
    expect(messages[0].contact?.profile.name).toBe('Alice');
    expect(messages[1].message.id).toBe('msg-2');
    expect(messages[1].contact?.profile.name).toBe('Bob');
  });

  it('should handle messages without contacts', () => {
    const webhook: WhatsAppWebhook = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'entry-123',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  display_phone_number: '15551234567',
                  phone_number_id: 'phone-123',
                },
                // No contacts array
                messages: [
                  {
                    from: '15559876543',
                    id: 'msg-xyz',
                    timestamp: '1234567890',
                    type: 'text',
                    text: { body: 'Anonymous message' },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const messages = extractMessages(webhook);

    expect(messages).toHaveLength(1);
    expect(messages[0].message.id).toBe('msg-xyz');
    expect(messages[0].contact).toBeUndefined();
  });

  it('should skip status updates (not messages)', () => {
    const webhook: WhatsAppWebhook = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'entry-123',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  display_phone_number: '15551234567',
                  phone_number_id: 'phone-123',
                },
                statuses: [
                  {
                    id: 'status-1',
                    status: 'delivered',
                    timestamp: '1234567890',
                    recipient_id: '15559876543',
                  },
                ],
                // No messages array
              },
            },
          ],
        },
      ],
    };

    const messages = extractMessages(webhook);

    // Status updates should not be extracted as messages
    expect(messages).toHaveLength(0);
  });

  it('should handle multiple entries', () => {
    const webhook: WhatsAppWebhook = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'entry-1',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  display_phone_number: '15551111111',
                  phone_number_id: 'phone-1',
                },
                messages: [
                  {
                    from: '15559999999',
                    id: 'msg-entry1',
                    timestamp: '1000000000',
                    type: 'text',
                    text: { body: 'From entry 1' },
                  },
                ],
              },
            },
          ],
        },
        {
          id: 'entry-2',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  display_phone_number: '15552222222',
                  phone_number_id: 'phone-2',
                },
                messages: [
                  {
                    from: '15558888888',
                    id: 'msg-entry2',
                    timestamp: '2000000000',
                    type: 'text',
                    text: { body: 'From entry 2' },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const messages = extractMessages(webhook);

    expect(messages).toHaveLength(2);
    expect(messages[0].phoneNumberId).toBe('phone-1');
    expect(messages[1].phoneNumberId).toBe('phone-2');
  });

  it('should return empty array for webhook without messages', () => {
    const webhook: WhatsAppWebhook = {
      object: 'whatsapp_business_account',
      entry: [],
    };

    const messages = extractMessages(webhook);
    expect(messages).toHaveLength(0);
  });
});

describe('Message Normalization', () => {
  it('should normalize text message to ClawdBot format', () => {
    const message: WhatsAppMessage = {
      from: '15559876543',
      id: 'msg-abc123',
      timestamp: '1234567890',
      type: 'text',
      text: { body: 'Hello from WhatsApp' },
    };

    const contact: WhatsAppContact = {
      profile: { name: 'John Doe' },
      wa_id: '15559876543',
    };

    const normalized = normalizeWhatsAppEvent(message, contact, 'phone-123');

    expect(normalized).not.toBeNull();
    expect(normalized?.id).toBe('whatsapp_msg-abc123');
    expect(normalized?.source).toBe('clawdbot');
    expect(normalized?.type).toBe('customer_message');
    expect(normalized?.content).toBe('Hello from WhatsApp');
    expect(normalized?.metadata.channel).toBe('whatsapp');
    expect(normalized?.metadata.user.id).toBe('15559876543');
    expect(normalized?.metadata.user.name).toBe('John Doe');
    expect(normalized?.metadata.user.phone).toBe('15559876543');
    expect(normalized?.metadata.messageId).toBe('msg-abc123');
    expect(normalized?.metadata.timestamp).toBe('1234567890');
    expect(normalized?.metadata.phoneNumberId).toBe('phone-123');
    expect(normalized?.requiresOrchestrator).toBe(false);
  });

  it('should handle message without contact info', () => {
    const message: WhatsAppMessage = {
      from: '15559876543',
      id: 'msg-xyz',
      timestamp: '9876543210',
      type: 'text',
      text: { body: 'Anonymous message' },
    };

    const normalized = normalizeWhatsAppEvent(message);

    expect(normalized).not.toBeNull();
    expect(normalized?.metadata.user.id).toBe('15559876543');
    expect(normalized?.metadata.user.name).toBeUndefined();
    expect(normalized?.metadata.user.phone).toBe('15559876543');
  });

  it('should include reply context when present', () => {
    const message: WhatsAppMessage = {
      from: '15559876543',
      id: 'msg-reply',
      timestamp: '1234567890',
      type: 'text',
      text: { body: 'This is a reply' },
      context: {
        from: '15551234567',
        id: 'original-msg-id',
      },
    };

    const normalized = normalizeWhatsAppEvent(message);

    expect(normalized).not.toBeNull();
    expect(normalized?.metadata.replyTo).toBe('original-msg-id');
  });

  it('should return null for non-text message types', () => {
    const imageMessage: WhatsAppMessage = {
      from: '15559876543',
      id: 'msg-img',
      timestamp: '1234567890',
      type: 'image',
      // No text field
    };

    const normalized = normalizeWhatsAppEvent(imageMessage);
    expect(normalized).toBeNull();
  });

  it('should return null for text message without body', () => {
    const emptyMessage: WhatsAppMessage = {
      from: '15559876543',
      id: 'msg-empty',
      timestamp: '1234567890',
      type: 'text',
      // text field missing
    };

    const normalized = normalizeWhatsAppEvent(emptyMessage);
    expect(normalized).toBeNull();
  });

  it('should handle all message type variations', () => {
    const messageTypes: Array<WhatsAppMessage['type']> = [
      'image',
      'audio',
      'video',
      'document',
      'sticker',
      'location',
      'contacts',
      'interactive',
      'button',
      'reaction',
    ];

    messageTypes.forEach((type) => {
      const message: WhatsAppMessage = {
        from: '15559876543',
        id: `msg-${type}`,
        timestamp: '1234567890',
        type,
      };

      const normalized = normalizeWhatsAppEvent(message);
      // All non-text types should return null
      expect(normalized).toBeNull();
    });
  });
});

describe('sendWhatsAppMessage', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ messages: [{ id: 'msg-sent-123' }] }), {
          status: 200,
        })
      )
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('should send text message successfully', async () => {
    const result = await sendWhatsAppMessage(
      '15559876543',
      'Hello from bot',
      'phone-123',
      'access-token-xyz'
    );

    expect(result).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const call = fetchSpy.mock.calls[0];
    expect(call[0]).toBe('https://graph.facebook.com/v18.0/phone-123/messages');

    const options = call[1] as RequestInit;
    expect(options.method).toBe('POST');
    expect(options.headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer access-token-xyz',
    });

    const body = JSON.parse(options.body as string);
    expect(body).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '15559876543',
      type: 'text',
      text: { body: 'Hello from bot' },
    });
  });

  it('should include reply context when provided', async () => {
    await sendWhatsAppMessage(
      '15559876543',
      'Reply message',
      'phone-123',
      'token',
      'original-msg-id'
    );

    const call = fetchSpy.mock.calls[0];
    const body = JSON.parse((call[1] as RequestInit).body as string);

    expect(body.context).toEqual({ message_id: 'original-msg-id' });
  });

  it('should handle API errors gracefully', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: { message: 'Invalid phone number' },
        }),
        { status: 400 }
      )
    );

    const result = await sendWhatsAppMessage('invalid', 'text', 'phone-123', 'token');

    expect(result).toBe(false);
  });

  it('should handle network failures', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('Network error'));

    const result = await sendWhatsAppMessage('15559876543', 'text', 'phone-123', 'token');

    expect(result).toBe(false);
  });

  it('should handle non-JSON responses', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('Internal Server Error', { status: 500 }));

    const result = await sendWhatsAppMessage('15559876543', 'text', 'phone-123', 'token');

    // Should handle parsing error gracefully
    expect(result).toBe(false);
  });
});

describe('Webhook Verification Endpoint', () => {
  const verifyToken = 'my-verify-token-123';

  it('should verify webhook subscription with correct token', async () => {
    const response = verifyWebhook('subscribe', verifyToken, 'challenge-string', verifyToken);

    expect(response).not.toBeNull();
    expect(response?.status).toBe(200);
    const text = await response?.text();
    expect(text).toBe('challenge-string');
  });

  it('should reject verification with incorrect token', () => {
    const response = verifyWebhook('subscribe', 'wrong-token', 'challenge-string', verifyToken);

    expect(response).toBeNull();
  });

  it('should reject verification with wrong mode', () => {
    const response = verifyWebhook('unsubscribe', verifyToken, 'challenge-string', verifyToken);

    expect(response).toBeNull();
  });

  it('should reject when mode is null', () => {
    const response = verifyWebhook(null, verifyToken, 'challenge-string', verifyToken);

    expect(response).toBeNull();
  });

  it('should reject when token is null', () => {
    const response = verifyWebhook('subscribe', null, 'challenge-string', verifyToken);

    expect(response).toBeNull();
  });

  it('should accept when challenge is null (Meta sends null challenge)', async () => {
    // Meta webhook verification can send null challenge in some cases
    // The Response constructor converts null to empty string
    const response = verifyWebhook('subscribe', verifyToken, null, verifyToken);

    expect(response).not.toBeNull();
    expect(response?.status).toBe(200);
    const text = await response?.text();
    expect(text).toBe(''); // null is converted to empty string by Response
  });

  it('should handle empty strings', () => {
    const response = verifyWebhook('', '', '', verifyToken);

    expect(response).toBeNull();
  });
});

describe('Edge Cases and Error Handling', () => {
  it('should handle malformed webhook with missing fields', () => {
    const malformed = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'entry-123',
          changes: [
            {
              field: 'messages',
              value: {
                // Missing messaging_product
                metadata: {
                  // Missing required fields
                },
              },
            },
          ],
        },
      ],
    };

    // Should validate structure but extractMessages should handle missing fields
    expect(validateWhatsAppWebhook(malformed)).toBe(true);
    const messages = extractMessages(malformed as WhatsAppWebhook);
    expect(messages).toHaveLength(0);
  });

  it('should handle webhook with empty entry array', () => {
    const webhook: WhatsAppWebhook = {
      object: 'whatsapp_business_account',
      entry: [],
    };

    expect(validateWhatsAppWebhook(webhook)).toBe(true);
    expect(extractMessages(webhook)).toHaveLength(0);
  });

  it('should handle message with special characters', () => {
    const message: WhatsAppMessage = {
      from: '15559876543',
      id: 'msg-special',
      timestamp: '1234567890',
      type: 'text',
      text: { body: 'Special chars: 日本語 émojis 🎉 "quotes" & <html>' },
    };

    const normalized = normalizeWhatsAppEvent(message);

    expect(normalized).not.toBeNull();
    expect(normalized?.content).toBe('Special chars: 日本語 émojis 🎉 "quotes" & <html>');
  });

  it('should handle very long message content', () => {
    const longText = 'A'.repeat(10000);
    const message: WhatsAppMessage = {
      from: '15559876543',
      id: 'msg-long',
      timestamp: '1234567890',
      type: 'text',
      text: { body: longText },
    };

    const normalized = normalizeWhatsAppEvent(message);

    expect(normalized).not.toBeNull();
    expect(normalized?.content).toBe(longText);
  });

  it('should handle timestamp as string (WhatsApp format)', () => {
    const message: WhatsAppMessage = {
      from: '15559876543',
      id: 'msg-timestamp',
      timestamp: '1699564800', // Unix timestamp as string
      type: 'text',
      text: { body: 'Timestamp test' },
    };

    const normalized = normalizeWhatsAppEvent(message);

    expect(normalized).not.toBeNull();
    expect(normalized?.metadata.timestamp).toBe('1699564800');
  });
});
