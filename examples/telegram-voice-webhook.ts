/**
 * Example: Telegram Voice Message Webhook Handler
 *
 * This example shows how to integrate voice message handling
 * into your Telegram webhook endpoint.
 */

import {
  verifyTelegramSignature,
  validateTelegramUpdate,
  isVoiceOrAudioMessage,
  handleVoiceMessage,
  normalizeTelegramEvent,
  sendTelegramMessage,
  type TelegramUpdate,
} from '../src/handlers/channels/telegram';
import type { Env } from '../src/types';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Only accept POST requests
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    // Verify webhook signature
    const secretToken = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
    if (!env.TELEGRAM_SECRET_TOKEN || !verifyTelegramSignature(secretToken, env.TELEGRAM_SECRET_TOKEN)) {
      return new Response('Unauthorized', { status: 401 });
    }

    // Parse update
    const update = await request.json() as TelegramUpdate;

    // Validate update payload
    if (!validateTelegramUpdate(update)) {
      return new Response('Invalid update payload', { status: 400 });
    }

    const message = update.message;
    if (!message) {
      return new Response('No message in update', { status: 400 });
    }

    // Route 1: Voice/Audio Messages → Transcription
    if (isVoiceOrAudioMessage(message)) {
      return await handleVoiceMessage(env, update);
    }

    // Route 2: Text Messages → Normal processing
    const normalizedEvent = normalizeTelegramEvent(update);
    if (normalizedEvent) {
      // Process text message
      // - Check FAQ patterns
      // - Forward to ClawdBot handler
      // - etc.

      const response = `Received your message: "${normalizedEvent.content}"`;
      await sendTelegramMessage(
        message.chat.id,
        response,
        env.TELEGRAM_BOT_TOKEN!,
        message.message_id
      );

      return new Response('OK', { status: 200 });
    }

    // Unknown message type
    return new Response('Unsupported message type', { status: 400 });
  },
};

/**
 * Example: Setting up webhook
 *
 * Run this once to configure your Telegram webhook:
 */
export async function setupWebhook(env: Env) {
  const { setTelegramWebhook } = await import('../src/handlers/channels/telegram');

  const webhookUrl = 'https://your-worker.your-domain.workers.dev/telegram/webhook';
  const success = await setTelegramWebhook(webhookUrl, env.TELEGRAM_BOT_TOKEN!);

  if (success) {
    console.log('✅ Webhook configured successfully');
  } else {
    console.error('❌ Failed to configure webhook');
  }
}

/**
 * Example: Testing voice transcription locally
 *
 * You can test with curl:
 *
 * ```bash
 * curl -X POST https://your-worker.your-domain.workers.dev/telegram/webhook \
 *   -H "Content-Type: application/json" \
 *   -H "X-Telegram-Bot-Api-Secret-Token: your-secret-token" \
 *   -d '{
 *     "update_id": 10000,
 *     "message": {
 *       "message_id": 1,
 *       "from": {
 *         "id": 123456789,
 *         "is_bot": false,
 *         "first_name": "John"
 *       },
 *       "chat": {
 *         "id": 123456789,
 *         "type": "private"
 *       },
 *       "date": 1609459200,
 *       "voice": {
 *         "file_id": "AwACAgIAAxkBAAIC...",
 *         "file_unique_id": "AgADAgAD",
 *         "duration": 5,
 *         "mime_type": "audio/ogg"
 *       }
 *     }
 *   }'
 * ```
 */

/**
 * Example: Flow diagram
 *
 * User sends voice message
 *     ↓
 * Telegram sends webhook to your Worker
 *     ↓
 * Worker receives update
 *     ↓
 * isVoiceOrAudioMessage() → true
 *     ↓
 * handleVoiceMessage()
 *     ├─→ Download audio file
 *     ├─→ Transcribe with Workers AI
 *     ├─→ Save to database
 *     └─→ Reply to user
 *     ↓
 * User sees: "✅ 音声を文字起こししました: [transcription]"
 */
