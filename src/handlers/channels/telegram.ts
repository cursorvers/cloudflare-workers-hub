/**
 * Telegram Channel Handler
 *
 * Telegram Bot API Webhook を処理し、ClawdBot ハンドラに転送
 * https://core.telegram.org/bots/api
 */

import { NormalizedEvent } from '../../types';
import { safeLog } from '../../utils/log-sanitizer';

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
  reply_to_message?: TelegramMessage;
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
 * Normalize Telegram update to ClawdBot format
 */
export function normalizeTelegramEvent(update: TelegramUpdate): NormalizedEvent | null {
  const message = update.message;
  if (!message?.text) return null;

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

export default {
  verifyTelegramSignature,
  validateTelegramUpdate,
  normalizeTelegramEvent,
  sendTelegramMessage,
  setTelegramWebhook,
};
