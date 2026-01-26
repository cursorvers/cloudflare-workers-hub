/**
 * Telegram Channel Handler
 *
 * Telegram Bot API Webhook を処理し、ClawdBot ハンドラに転送
 * https://core.telegram.org/bots/api
 */

import { NormalizedEvent, Env } from '../../types';
import { safeLog } from '../../utils/log-sanitizer';
import { saveConversation } from '../memory';
import { handleGenericWebhook } from '../generic-webhook';
import clawdbotHandler from '../clawdbot';

/**
 * Verify Telegram webhook signature using X-Telegram-Bot-Api-Secret-Token header
 * Uses constant-time comparison to prevent timing attacks
 * https://core.telegram.org/bots/api#setwebhook
 */
export function verifyTelegramSignature(
  secretTokenHeader: string | null,
  expectedSecret: string
): boolean {
  if (!secretTokenHeader || !expectedSecret) {
    return false;
  }

  // Constant-time comparison to prevent timing attacks
  if (secretTokenHeader.length !== expectedSecret.length) {
    return false;
  }

  let result = 0;
  for (let i = 0; i < secretTokenHeader.length; i++) {
    result |= secretTokenHeader.charCodeAt(i) ^ expectedSecret.charCodeAt(i);
  }
  return result === 0;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  voice?: TelegramVoice;
  audio?: TelegramAudio;
  reply_to_message?: TelegramMessage;
}

export interface TelegramVoice {
  file_id: string;
  file_unique_id: string;
  duration: number;
  mime_type?: string;  // audio/ogg
  file_size?: number;
}

export interface TelegramAudio {
  file_id: string;
  file_unique_id: string;
  duration: number;
  performer?: string;
  title?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export interface TelegramChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

/**
 * Validate Telegram update payload
 */
export function validateTelegramUpdate(payload: unknown): payload is TelegramUpdate {
  if (!payload || typeof payload !== 'object') return false;
  const p = payload as Record<string, unknown>;
  return typeof p.update_id === 'number';
}

/**
 * Telegram getFile API response
 */
interface TelegramFileResponse {
  ok: boolean;
  result?: {
    file_id: string;
    file_unique_id: string;
    file_size?: number;
    file_path?: string;
  };
  description?: string;
}

/**
 * Download file from Telegram servers
 */
async function downloadTelegramFile(
  botToken: string,
  fileId: string
): Promise<ArrayBuffer | null> {
  try {
    // Step 1: Get file path
    const fileInfoResponse = await fetch(
      `https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`
    );
    const fileInfo = await fileInfoResponse.json() as TelegramFileResponse;

    if (!fileInfo.ok || !fileInfo.result?.file_path) {
      safeLog.error('Failed to get file info from Telegram:', fileInfo.description);
      return null;
    }

    // Step 2: Download file
    const fileUrl = `https://api.telegram.org/file/bot${botToken}/${fileInfo.result.file_path}`;
    const fileResponse = await fetch(fileUrl);

    if (!fileResponse.ok) {
      safeLog.error('Failed to download file from Telegram:', fileResponse.statusText);
      return null;
    }

    return await fileResponse.arrayBuffer();
  } catch (error) {
    safeLog.error('Error downloading Telegram file:', error);
    return null;
  }
}

/**
 * Transcribe audio using Workers AI
 */
async function transcribeAudio(
  env: Env,
  audioBuffer: ArrayBuffer
): Promise<string | null> {
  try {
    // Workers AI Automatic Speech Recognition
    // https://developers.cloudflare.com/workers-ai/models/automatic-speech-recognition/
    const uint8Array = new Uint8Array(audioBuffer);
    const audioArray = Array.from(uint8Array);

    const response = await env.AI.run(
      '@cf/openai/whisper',
      {
        audio: audioArray,
      }
    );

    // Response format: { text: string }
    if (response && typeof response === 'object' && 'text' in response) {
      return (response as { text: string }).text;
    }

    safeLog.error('Unexpected AI response format:', response);
    return null;
  } catch (error) {
    safeLog.error('Error transcribing audio:', error);
    return null;
  }
}

/**
 * Handle voice/audio message
 */
export async function handleVoiceMessage(
  env: Env,
  update: TelegramUpdate
): Promise<Response> {
  const message = update.message;
  if (!message) {
    return new Response('No message found', { status: 400 });
  }

  const voiceOrAudio = message.voice || message.audio;
  if (!voiceOrAudio) {
    return new Response('No voice or audio found', { status: 400 });
  }

  const botToken = env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    safeLog.error('TELEGRAM_BOT_TOKEN not configured');
    return new Response('Bot token not configured', { status: 500 });
  }

  try {
    // Step 1: Download audio file
    const audioBuffer = await downloadTelegramFile(botToken, voiceOrAudio.file_id);
    if (!audioBuffer) {
      await sendTelegramMessage(
        message.chat.id,
        '❌ 音声ファイルのダウンロードに失敗しました',
        botToken,
        message.message_id
      );
      return new Response('Failed to download audio', { status: 500 });
    }

    // Step 2: Optionally save to R2 for staging
    if (env.AUDIO_STAGING) {
      const filename = `telegram_${message.chat.id}_${message.message_id}_${Date.now()}.ogg`;
      await env.AUDIO_STAGING.put(filename, audioBuffer, {
        customMetadata: {
          source: 'telegram',
          chatId: String(message.chat.id),
          messageId: String(message.message_id),
          userId: String(message.from?.id || 'unknown'),
          duration: String(voiceOrAudio.duration),
        },
      });
      safeLog.info(`Audio saved to R2: ${filename}`);
    }

    // Step 3: Transcribe audio
    const transcription = await transcribeAudio(env, audioBuffer);
    if (!transcription) {
      await sendTelegramMessage(
        message.chat.id,
        '❌ 音声の文字起こしに失敗しました',
        botToken,
        message.message_id
      );
      return new Response('Failed to transcribe audio', { status: 500 });
    }

    // Step 4: Save transcription to conversation history
    await saveConversation(env, {
      id: `telegram_${update.update_id}_${message.message_id}`,
      user_id: String(message.from?.id || message.chat.id),
      channel: 'telegram',
      source: 'voice',
      role: 'user',
      content: transcription,
      metadata: {
        messageId: message.message_id,
        chatId: message.chat.id,
        duration: voiceOrAudio.duration,
        fileId: voiceOrAudio.file_id,
      },
    });

    // Step 5: Reply with transcription confirmation
    const confirmationMessage = `✅ 音声を文字起こししました:\n\n"${transcription}"`;
    await sendTelegramMessage(
      message.chat.id,
      confirmationMessage,
      botToken,
      message.message_id
    );

    return new Response(JSON.stringify({
      success: true,
      transcription,
      duration: voiceOrAudio.duration
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    safeLog.error('Error handling voice message:', error);
    return new Response('Internal error', { status: 500 });
  }
}

/**
 * Check if message contains voice or audio
 */
export function isVoiceOrAudioMessage(message: TelegramMessage): boolean {
  return !!(message.voice || message.audio);
}

/**
 * Normalize Telegram update to ClawdBot format
 */
export function normalizeTelegramEvent(update: TelegramUpdate): NormalizedEvent | null {
  const message = update.message;
  if (!message) return null;

  // Voice/audio messages will be handled separately by handleVoiceMessage
  // This function only handles text messages
  if (!message.text) return null;

  return {
    id: `telegram_${update.update_id}_${message.message_id}`,
    source: 'clawdbot',
    type: 'customer_message',
    content: message.text,
    metadata: {
      channel: 'telegram',
      user: {
        id: String(message.from?.id || message.chat.id),
        name: message.from
          ? `${message.from.first_name}${message.from.last_name ? ' ' + message.from.last_name : ''}`
          : undefined,
        username: message.from?.username,
      },
      chatId: message.chat.id,
      messageId: message.message_id,
      replyToMessageId: message.reply_to_message?.message_id,
      languageCode: message.from?.language_code,
    },
    requiresOrchestrator: false, // Will be determined by ClawdBot handler
  };
}

/**
 * Send message to Telegram chat
 */
export async function sendTelegramMessage(
  chatId: number,
  text: string,
  botToken: string,
  replyToMessageId?: number
): Promise<boolean> {
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          reply_to_message_id: replyToMessageId,
          parse_mode: 'HTML',
        }),
      }
    );

    const result = await response.json() as { ok: boolean; description?: string };
    if (!result.ok) {
      safeLog.error('Telegram sendMessage error:', result.description);
      return false;
    }
    return true;
  } catch (error) {
    safeLog.error('Telegram sendMessage failed:', error);
    return false;
  }
}

/**
 * Set webhook URL for Telegram bot
 * Allows text messages, voice messages, audio messages, and callback queries
 */
export async function setTelegramWebhook(
  webhookUrl: string,
  botToken: string
): Promise<boolean> {
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${botToken}/setWebhook`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: webhookUrl,
          allowed_updates: ['message', 'callback_query'],
          // message will include text, voice, and audio
        }),
      }
    );

    const result = await response.json() as { ok: boolean; description?: string };
    return result.ok;
  } catch (error) {
    safeLog.error('Telegram setWebhook failed:', error);
    return false;
  }
}

/**
 * Handle incoming Telegram webhook request end-to-end:
 * signature verification, validation, FAQ offload via Workers AI, Orchestrator forwarding.
 */
export async function handleTelegramWebhook(request: Request, env: Env): Promise<Response> {
  // Verify Telegram signature if secret token is configured
  if (env.TELEGRAM_SECRET_TOKEN) {
    const secretTokenHeader = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
    if (!verifyTelegramSignature(secretTokenHeader, env.TELEGRAM_SECRET_TOKEN)) {
      safeLog.warn('[Telegram] Invalid or missing secret token');
      return new Response('Unauthorized', { status: 401 });
    }
  }

  let payload: TelegramUpdate;

  try {
    payload = await request.json() as TelegramUpdate;
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  if (!validateTelegramUpdate(payload)) {
    return new Response('Invalid Telegram update', { status: 400 });
  }

  // Normalize to ClawdBot format
  const event = normalizeTelegramEvent(payload);
  if (!event) {
    return new Response('OK', { status: 200 });
  }

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
      const chatId = event.metadata.chatId as number;

      if (env.TELEGRAM_BOT_TOKEN && chatId) {
        await sendTelegramMessage(
          chatId,
          aiResponse,
          env.TELEGRAM_BOT_TOKEN,
          event.metadata.messageId as number | undefined
        );
      }

      return new Response('OK', { status: 200 });
    } catch (error) {
      safeLog.error('[Telegram] Workers AI error', { error: String(error) });
      // Fall through to Orchestrator instead of returning OK silently
    }
  }

  // Forward to Orchestrator for complex requests
  return handleGenericWebhook(event, env);
}

export default {
  verifyTelegramSignature,
  validateTelegramUpdate,
  isVoiceOrAudioMessage,
  normalizeTelegramEvent,
  handleVoiceMessage,
  sendTelegramMessage,
  setTelegramWebhook,
  handleTelegramWebhook,
};
