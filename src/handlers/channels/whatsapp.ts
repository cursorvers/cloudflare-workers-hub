/**
 * WhatsApp Channel Handler
 *
 * WhatsApp Business Cloud API Webhook を処理し、ClawdBot ハンドラに転送
 * https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks
 */

import { NormalizedEvent, Env } from '../../types';
import { safeLog } from '../../utils/log-sanitizer';
import { handleGenericWebhook } from '../generic-webhook';
import clawdbotHandler from '../clawdbot';

/**
 * Verify WhatsApp webhook signature using HMAC-SHA256
 * https://developers.facebook.com/docs/graph-api/webhooks/getting-started#verification-requests
 */
export async function verifyWhatsAppSignature(
  signatureHeader: string | null,
  body: string,
  appSecret: string
): Promise<boolean> {
  if (!signatureHeader || !appSecret || !body) {
    return false;
  }

  // Expected format: sha256=<hash>
  if (!signatureHeader.startsWith('sha256=')) {
    return false;
  }

  const providedHash = signatureHeader.slice(7); // Remove 'sha256=' prefix

  try {
    // Create HMAC-SHA256 hash using Web Crypto API
    const encoder = new TextEncoder();
    const keyData = encoder.encode(appSecret);
    const messageData = encoder.encode(body);

    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );

    const signature = await crypto.subtle.sign('HMAC', cryptoKey, messageData);

    // Convert to hex string
    const expectedHash = Array.from(new Uint8Array(signature))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    // Constant-time comparison to prevent timing attacks
    if (providedHash.length !== expectedHash.length) {
      return false;
    }

    let result = 0;
    for (let i = 0; i < providedHash.length; i++) {
      result |= providedHash.charCodeAt(i) ^ expectedHash.charCodeAt(i);
    }
    return result === 0;
  } catch (error) {
    safeLog.error('WhatsApp signature verification error:', error);
    return false;
  }
}

export interface WhatsAppWebhook {
  object: 'whatsapp_business_account';
  entry: WhatsAppEntry[];
}

export interface WhatsAppEntry {
  id: string;
  changes: WhatsAppChange[];
}

export interface WhatsAppChange {
  value: {
    messaging_product: 'whatsapp';
    metadata: {
      display_phone_number: string;
      phone_number_id: string;
    };
    contacts?: WhatsAppContact[];
    messages?: WhatsAppMessage[];
    statuses?: WhatsAppStatus[];
  };
  field: 'messages';
}

export interface WhatsAppContact {
  profile: {
    name: string;
  };
  wa_id: string;
}

export interface WhatsAppMessage {
  from: string;
  id: string;
  timestamp: string;
  type: 'text' | 'image' | 'audio' | 'video' | 'document' | 'sticker' | 'location' | 'contacts' | 'interactive' | 'button' | 'reaction';
  text?: {
    body: string;
  };
  context?: {
    from: string;
    id: string;
  };
}

export interface WhatsAppStatus {
  id: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  timestamp: string;
  recipient_id: string;
}

/**
 * Validate WhatsApp webhook payload
 */
export function validateWhatsAppWebhook(payload: unknown): payload is WhatsAppWebhook {
  if (!payload || typeof payload !== 'object') return false;
  const p = payload as Record<string, unknown>;
  return p.object === 'whatsapp_business_account' && Array.isArray(p.entry);
}

/**
 * Extract messages from WhatsApp webhook
 */
export function extractMessages(webhook: WhatsAppWebhook): Array<{
  message: WhatsAppMessage;
  contact?: WhatsAppContact;
  phoneNumberId: string;
}> {
  const messages: Array<{
    message: WhatsAppMessage;
    contact?: WhatsAppContact;
    phoneNumberId: string;
  }> = [];

  for (const entry of webhook.entry) {
    for (const change of entry.changes) {
      if (change.field === 'messages' && change.value.messages) {
        const contacts = change.value.contacts || [];
        for (const msg of change.value.messages) {
          const contact = contacts.find((c) => c.wa_id === msg.from);
          messages.push({
            message: msg,
            contact,
            phoneNumberId: change.value.metadata.phone_number_id,
          });
        }
      }
    }
  }

  return messages;
}

/**
 * Normalize WhatsApp message to ClawdBot format
 */
export function normalizeWhatsAppEvent(
  message: WhatsAppMessage,
  contact?: WhatsAppContact,
  phoneNumberId?: string
): NormalizedEvent | null {
  // Only handle text messages for now
  if (message.type !== 'text' || !message.text?.body) return null;

  return {
    id: `whatsapp_${message.id}`,
    source: 'clawdbot',
    type: 'customer_message',
    content: message.text.body,
    metadata: {
      channel: 'whatsapp',
      user: {
        id: message.from,
        name: contact?.profile.name,
        phone: message.from,
      },
      messageId: message.id,
      timestamp: message.timestamp,
      phoneNumberId,
      replyTo: message.context?.id,
    },
    requiresOrchestrator: false, // Will be determined by ClawdBot handler
  };
}

/**
 * Send message via WhatsApp Cloud API
 */
export async function sendWhatsAppMessage(
  to: string,
  text: string,
  phoneNumberId: string,
  accessToken: string,
  replyToMessageId?: string
): Promise<boolean> {
  try {
    const body: Record<string, unknown> = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { body: text },
    };

    if (replyToMessageId) {
      body.context = { message_id: replyToMessageId };
    }

    const response = await fetch(
      `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(body),
      }
    );

    const result = await response.json() as { messages?: Array<{ id: string }>; error?: { message: string } };
    if (result.error) {
      safeLog.error('WhatsApp sendMessage error:', result.error.message);
      return false;
    }
    return true;
  } catch (error) {
    safeLog.error('WhatsApp sendMessage failed:', error);
    return false;
  }
}

/**
 * Verify webhook callback (for Meta webhook verification)
 */
export function verifyWebhook(
  mode: string | null,
  token: string | null,
  challenge: string | null,
  verifyToken: string
): Response | null {
  if (mode === 'subscribe' && token === verifyToken) {
    return new Response(challenge, { status: 200 });
  }
  return null;
}

/**
 * Handle incoming WhatsApp webhook request end-to-end:
 * verification (GET), signature check, FAQ offload via Workers AI, Orchestrator forwarding.
 */
export async function handleWhatsAppWebhook(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  // Handle webhook verification (GET request)
  if (request.method === 'GET') {
    const mode = url.searchParams.get('hub.mode');
    const token = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge');

    if (env.WHATSAPP_VERIFY_TOKEN) {
      const verifyResponse = verifyWebhook(mode, token, challenge, env.WHATSAPP_VERIFY_TOKEN);
      if (verifyResponse) return verifyResponse;
    }
    return new Response('Forbidden', { status: 403 });
  }

  // Handle webhook events (POST request)
  // Read body as text first for signature verification
  const body = await request.text();

  // Verify WhatsApp HMAC signature if app secret is configured
  if (env.WHATSAPP_APP_SECRET) {
    const signatureHeader = request.headers.get('X-Hub-Signature-256');
    const isValid = await verifyWhatsAppSignature(signatureHeader, body, env.WHATSAPP_APP_SECRET);
    if (!isValid) {
      safeLog.warn('[WhatsApp] Invalid HMAC signature');
      return new Response('Unauthorized', { status: 401 });
    }
  }

  let payload: WhatsAppWebhook;

  try {
    payload = JSON.parse(body) as WhatsAppWebhook;
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  if (!validateWhatsAppWebhook(payload)) {
    return new Response('Invalid WhatsApp webhook', { status: 400 });
  }

  // Extract and process messages
  const messages = extractMessages(payload);

  for (const { message, contact, phoneNumberId } of messages) {
    const event = normalizeWhatsAppEvent(message, contact, phoneNumberId);
    if (!event) continue;

    // Process through ClawdBot handler logic
    const faqCategory = clawdbotHandler.detectFAQCategory(event.content);
    const needsEscalation = clawdbotHandler.requiresEscalation(event.content);

    if (faqCategory && !needsEscalation) {
      // Handle FAQ with Workers AI
      const prompt = clawdbotHandler.generateFAQPrompt(faqCategory, event.content);
      try {
        const response = await (env.AI.run as (model: string, input: unknown) => Promise<unknown>)(
          '@cf/meta/llama-3.1-8b-instruct',
          {
            messages: [
              { role: 'system', content: 'あなたは丁寧なカスタマーサポート担当です。日本語で簡潔に回答してください。' },
              { role: 'user', content: prompt },
            ],
            max_tokens: 256,
          }
        );

        const aiResponse = (response as { response: string }).response;

        if (env.WHATSAPP_ACCESS_TOKEN && phoneNumberId) {
          await sendWhatsAppMessage(
            message.from,
            aiResponse,
            phoneNumberId,
            env.WHATSAPP_ACCESS_TOKEN,
            message.id
          );
        }
        continue; // Successfully handled, move to next message
      } catch (error) {
        safeLog.error('[WhatsApp] Workers AI error', { error: String(error) });
        // Fall through to Orchestrator instead of silently failing
      }
    }

    // Forward to Orchestrator for complex requests or AI failures
    await handleGenericWebhook(event, env);
  }

  return new Response('OK', { status: 200 });
}

export default {
  verifyWhatsAppSignature,
  validateWhatsAppWebhook,
  extractMessages,
  normalizeWhatsAppEvent,
  sendWhatsAppMessage,
  verifyWebhook,
  handleWhatsAppWebhook,
};
