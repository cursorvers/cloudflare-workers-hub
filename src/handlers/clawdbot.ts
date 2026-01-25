/**
 * ClawdBot Handler
 *
 * 顧客対応チャネル（WhatsApp, Telegram）からのメッセージを処理
 * FAQ は Workers AI でオフロード、複雑なリクエストは Orchestrator へ
 */

import { NormalizedEvent } from '../types';

export interface ClawdBotMessage {
  id: string;
  channel: 'whatsapp' | 'telegram' | 'web' | 'unknown';
  user: {
    id: string;
    name?: string;
    phone?: string;
  };
  message: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
  replyTo?: string; // For threaded conversations
}

export interface ClawdBotResponse {
  success: boolean;
  messageId?: string;
  response?: string;
  handledBy: 'workers-ai' | 'orchestrator' | 'faq';
  followUpRequired?: boolean;
}

// FAQ patterns for Workers AI offload
const FAQ_PATTERNS: Array<{ pattern: RegExp; category: string }> = [
  { pattern: /^(営業時間|opening hours|what time)/i, category: 'hours' },
  { pattern: /^(場所|location|where|住所|address)/i, category: 'location' },
  { pattern: /^(価格|料金|price|cost|いくら)/i, category: 'pricing' },
  { pattern: /^(予約|book|reserve|appointment)/i, category: 'booking' },
  { pattern: /^(キャンセル|cancel)/i, category: 'cancellation' },
  { pattern: /^(支払い|payment|pay|決済)/i, category: 'payment' },
  { pattern: /^(返品|返金|refund|return)/i, category: 'refund' },
  { pattern: /^(配送|delivery|shipping|届く)/i, category: 'shipping' },
];

// Escalation triggers (always forward to Orchestrator)
const ESCALATION_TRIGGERS = [
  /クレーム|complaint|angry|怒/i,
  /緊急|urgent|emergency|至急/i,
  /責任者|manager|supervisor|上司/i,
  /法的|legal|lawyer|弁護士/i,
  /返金.*全額|full.*refund/i,
];

/**
 * Detect if message is a FAQ
 */
export function detectFAQCategory(message: string): string | null {
  for (const { pattern, category } of FAQ_PATTERNS) {
    if (pattern.test(message)) {
      return category;
    }
  }
  return null;
}

/**
 * Check if message requires escalation
 */
export function requiresEscalation(message: string): boolean {
  return ESCALATION_TRIGGERS.some(trigger => trigger.test(message));
}

/**
 * Normalize ClawdBot message into standard event
 */
export function normalizeClawdBotEvent(payload: ClawdBotMessage): NormalizedEvent {
  const faqCategory = detectFAQCategory(payload.message);
  const needsEscalation = requiresEscalation(payload.message);

  return {
    id: `clawdbot_${payload.id}`,
    source: 'clawdbot',
    type: needsEscalation ? 'escalation' : faqCategory ? 'faq' : 'customer_message',
    content: payload.message,
    metadata: {
      channel: payload.channel,
      user: payload.user,
      faqCategory,
      needsEscalation,
      replyTo: payload.replyTo,
      originalTimestamp: payload.timestamp,
    },
    // FAQ can be handled by Workers AI, escalations need Orchestrator
    requiresOrchestrator: needsEscalation || !faqCategory,
  };
}

/**
 * Generate FAQ response prompt for Workers AI
 */
export function generateFAQPrompt(category: string, message: string): string {
  const prompts: Record<string, string> = {
    hours: `顧客が営業時間について質問しています。一般的な営業時間（平日9:00-18:00など）を想定して、丁寧に回答してください。質問: "${message}"`,
    location: `顧客が場所・住所について質問しています。詳細な情報がないため、「担当者に確認して折り返しご連絡します」と丁寧に回答してください。質問: "${message}"`,
    pricing: `顧客が価格について質問しています。具体的な価格は言及せず、「詳細なお見積もりをお送りします」と案内してください。質問: "${message}"`,
    booking: `顧客が予約について質問しています。予約方法を案内するか、「担当者から折り返しご連絡します」と回答してください。質問: "${message}"`,
    cancellation: `顧客がキャンセルについて質問しています。キャンセルポリシーを確認中と伝え、「詳細を確認して折り返しご連絡します」と回答してください。質問: "${message}"`,
    payment: `顧客が支払いについて質問しています。一般的な支払い方法（クレジットカード、銀行振込など）を案内してください。質問: "${message}"`,
    refund: `顧客が返金について質問しています。返金ポリシーは担当者が確認すると伝え、「詳細を確認して折り返しご連絡します」と回答してください。質問: "${message}"`,
    shipping: `顧客が配送について質問しています。一般的な配送期間（3-5営業日など）を案内してください。質問: "${message}"`,
  };

  return prompts[category] || `顧客からの質問に丁寧に回答してください: "${message}"`;
}

/**
 * Format response for ClawdBot channels
 */
export function formatResponse(
  channel: ClawdBotMessage['channel'],
  response: string
): string {
  // Channel-specific formatting
  switch (channel) {
    case 'whatsapp':
      // WhatsApp supports basic formatting
      return response.replace(/\*\*(.*?)\*\*/g, '*$1*'); // Bold
    case 'telegram':
      // Telegram supports HTML
      return response.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>');
    default:
      return response;
  }
}

/**
 * Validate incoming ClawdBot payload
 */
export function validatePayload(payload: unknown): payload is ClawdBotMessage {
  if (!payload || typeof payload !== 'object') return false;

  const p = payload as Record<string, unknown>;
  return (
    typeof p.id === 'string' &&
    typeof p.channel === 'string' &&
    typeof p.message === 'string' &&
    typeof p.user === 'object' &&
    p.user !== null
  );
}

export default {
  detectFAQCategory,
  requiresEscalation,
  normalizeClawdBotEvent,
  generateFAQPrompt,
  formatResponse,
  validatePayload,
};
