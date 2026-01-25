/**
 * Secrets Validator
 *
 * 起動時にシークレットの存在と形式を検証
 * セキュリティリスクを早期に検出
 */

import { Env } from '../types';
import { safeLog } from './log-sanitizer';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  configured: string[];
}

interface SecretConfig {
  name: keyof Env;
  required: boolean;
  pattern?: RegExp;
  description: string;
}

// シークレット設定（チャネル別にグループ化）
const SECRETS_CONFIG: SecretConfig[] = [
  // Slack
  {
    name: 'SLACK_BOT_TOKEN',
    required: false,
    pattern: /^xoxb-[0-9]+-[0-9]+-[a-zA-Z0-9]+$/,
    description: 'Slack Bot OAuth Token',
  },
  {
    name: 'SLACK_SIGNING_SECRET',
    required: false,
    pattern: /^[a-f0-9]{32}$/,
    description: 'Slack Signing Secret',
  },

  // Discord
  {
    name: 'DISCORD_BOT_TOKEN',
    required: false,
    description: 'Discord Bot Token',
  },
  {
    name: 'DISCORD_PUBLIC_KEY',
    required: false,
    pattern: /^[a-f0-9]{64}$/,
    description: 'Discord Application Public Key',
  },

  // Telegram
  {
    name: 'TELEGRAM_BOT_TOKEN',
    required: false,
    pattern: /^\d+:[a-zA-Z0-9_-]+$/,
    description: 'Telegram Bot Token',
  },
  {
    name: 'TELEGRAM_SECRET_TOKEN',
    required: false,
    description: 'Telegram Webhook Secret Token',
  },

  // WhatsApp
  {
    name: 'WHATSAPP_ACCESS_TOKEN',
    required: false,
    description: 'WhatsApp Business API Access Token',
  },
  {
    name: 'WHATSAPP_VERIFY_TOKEN',
    required: false,
    description: 'WhatsApp Webhook Verify Token',
  },
  {
    name: 'WHATSAPP_PHONE_NUMBER_ID',
    required: false,
    pattern: /^\d+$/,
    description: 'WhatsApp Phone Number ID',
  },
  {
    name: 'WHATSAPP_APP_SECRET',
    required: false,
    pattern: /^[a-f0-9]{32}$/,
    description: 'WhatsApp/Meta App Secret for HMAC verification',
  },

  // Monitoring
  {
    name: 'SENTRY_DSN',
    required: false,
    pattern: /^https:\/\/[^@]+@[^/]+\/\d+$/,
    description: 'Sentry DSN',
  },
];

/**
 * チャネルのセキュリティペア検証
 * トークンがあるのに署名検証用シークレットがない場合は警告
 */
function validateSecurityPairs(env: Env, warnings: string[]): void {
  // Slack: BOT_TOKEN があるなら SIGNING_SECRET も必要
  if (env.SLACK_BOT_TOKEN && !env.SLACK_SIGNING_SECRET) {
    warnings.push(
      'SLACK_BOT_TOKEN is set but SLACK_SIGNING_SECRET is missing. Signature verification disabled.'
    );
  }

  // Discord: BOT_TOKEN があるなら PUBLIC_KEY も必要
  if (env.DISCORD_BOT_TOKEN && !env.DISCORD_PUBLIC_KEY) {
    warnings.push(
      'DISCORD_BOT_TOKEN is set but DISCORD_PUBLIC_KEY is missing. Signature verification disabled.'
    );
  }

  // Telegram: BOT_TOKEN があるなら SECRET_TOKEN も推奨
  if (env.TELEGRAM_BOT_TOKEN && !env.TELEGRAM_SECRET_TOKEN) {
    warnings.push(
      'TELEGRAM_BOT_TOKEN is set but TELEGRAM_SECRET_TOKEN is missing. Webhook verification disabled.'
    );
  }

  // WhatsApp: ACCESS_TOKEN があるなら APP_SECRET も推奨
  if (env.WHATSAPP_ACCESS_TOKEN && !env.WHATSAPP_APP_SECRET) {
    warnings.push(
      'WHATSAPP_ACCESS_TOKEN is set but WHATSAPP_APP_SECRET is missing. HMAC verification disabled.'
    );
  }
}

/**
 * シークレットの検証を実行
 */
export function validateSecrets(env: Env): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const configured: string[] = [];

  for (const config of SECRETS_CONFIG) {
    const value = env[config.name];

    if (config.required && !value) {
      errors.push(`Missing required secret: ${config.name} (${config.description})`);
      continue;
    }

    if (!value) {
      continue; // Optional and not set
    }

    configured.push(config.name);

    // パターン検証
    if (config.pattern && typeof value === 'string' && !config.pattern.test(value)) {
      warnings.push(
        `${config.name} format may be invalid. Expected pattern: ${config.pattern.source}`
      );
    }
  }

  // セキュリティペア検証
  validateSecurityPairs(env, warnings);

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    configured,
  };
}

/**
 * 起動時のセキュリティチェック
 * エラーがあれば起動を中止（厳格モード）
 * 警告があればログに記録して継続
 */
export function performStartupCheck(env: Env, strict = false): void {
  const result = validateSecrets(env);

  if (result.configured.length > 0) {
    safeLog.log(`[Secrets] Configured: ${result.configured.join(', ')}`);
  }

  if (result.warnings.length > 0) {
    for (const warning of result.warnings) {
      safeLog.warn(`[Secrets] Warning: ${warning}`);
    }
  }

  if (result.errors.length > 0) {
    for (const error of result.errors) {
      safeLog.error(`[Secrets] Error: ${error}`);
    }
    if (strict) {
      throw new Error(`Secrets validation failed: ${result.errors.join('; ')}`);
    }
  }
}

export default {
  validateSecrets,
  performStartupCheck,
};
