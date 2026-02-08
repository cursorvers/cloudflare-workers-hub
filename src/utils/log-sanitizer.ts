/**
 * Log Sanitizer
 *
 * ログ出力前に機密情報をマスキング
 * OWASP ログインジェクション対策
 */

// マスキング対象のパターン
const SENSITIVE_PATTERNS: Array<{
  pattern: RegExp;
  replacement: string;
  description: string;
}> = [
  // API Keys / Tokens
  {
    pattern: /\b(sk-[a-zA-Z0-9]{20,})\b/g,
    replacement: 'sk-***REDACTED***',
    description: 'OpenAI API Key',
  },
  {
    pattern: /\b(xox[baprs]-[0-9]+-[0-9]+-[a-zA-Z0-9]+)\b/g,
    replacement: 'xox*-***REDACTED***',
    description: 'Slack Token',
  },
  {
    pattern: /\b(\d{10,}:[a-zA-Z0-9_-]{35,})\b/g,
    replacement: '***TELEGRAM_TOKEN***',
    description: 'Telegram Bot Token',
  },
  {
    pattern: /\b(ghp_[a-zA-Z0-9]{36,})\b/g,
    replacement: 'ghp_***REDACTED***',
    description: 'GitHub Personal Access Token',
  },
  {
    pattern: /\b(gho_[a-zA-Z0-9]{36,})\b/g,
    replacement: 'gho_***REDACTED***',
    description: 'GitHub OAuth Token',
  },

  // JWT tokens (must come before generic password pattern)
  {
    pattern: /\beyJ[a-zA-Z0-9_-]*\.eyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*\b/g,
    replacement: '***JWT_TOKEN***',
    description: 'JWT Token',
  },

  // Passwords / Secrets (negative lookahead to avoid matching already redacted values or JWT tokens)
  {
    pattern: /(password|passwd|pwd|secret|token|api_key|apikey|auth)["']?\s*[:=]\s*["']?(?!\*\*\*|eyJ)([^"'\s,}]{8,})["']?/gi,
    replacement: '$1=***REDACTED***',
    description: 'Password/Secret Assignment',
  },

  // Email addresses (partial masking)
  {
    pattern: /\b([a-zA-Z0-9._%+-]+)@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\b/g,
    replacement: '***@$2',
    description: 'Email Address',
  },

  // Phone numbers
  {
    pattern: /\b(\+?[0-9]{1,4}[-.\s]?)?(\(?[0-9]{2,4}\)?[-.\s]?)?[0-9]{3,4}[-.\s]?[0-9]{3,4}\b/g,
    replacement: '***PHONE***',
    description: 'Phone Number',
  },

  // Credit card numbers
  {
    pattern: /\b[0-9]{4}[-\s]?[0-9]{4}[-\s]?[0-9]{4}[-\s]?[0-9]{4}\b/g,
    replacement: '****-****-****-****',
    description: 'Credit Card Number',
  },

  // Authorization headers
  {
    pattern: /(Bearer|Basic)\s+[a-zA-Z0-9+/=_-]{20,}/gi,
    replacement: '$1 ***REDACTED***',
    description: 'Authorization Header',
  },

  // AWS credentials
  {
    pattern: /\b(AKIA[0-9A-Z]{16})\b/g,
    replacement: 'AKIA***REDACTED***',
    description: 'AWS Access Key ID',
  },

  // Discord tokens
  {
    pattern: /\b([MN][A-Za-z\d]{23,}\.[\w-]{6}\.[\w-]{27})\b/g,
    replacement: '***DISCORD_TOKEN***',
    description: 'Discord Bot Token',
  },

  // Cloudflare API tokens
  {
    pattern: /\b(CF_[a-zA-Z0-9_]{32,})\b/g,
    replacement: 'CF_***REDACTED***',
    description: 'Cloudflare API Token (CF_ prefix)',
  },
  {
    pattern: /\b([a-f0-9]{37})\b/g,
    replacement: '***CF_API_KEY***',
    description: 'Cloudflare Global API Key (37 hex chars)',
  },

  // Supabase tokens
  {
    pattern: /\bsbp_[a-zA-Z0-9]{40,}\b/g,
    replacement: 'sbp_***REDACTED***',
    description: 'Supabase Service Role Key',
  },
  {
    pattern: /\beyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/g,
    replacement: '***SUPABASE_JWT***',
    description: 'Supabase JWT (anon/service key)',
  },

  // Stripe keys
  {
    pattern: /\b(sk_live_[a-zA-Z0-9]{24,})\b/g,
    replacement: 'sk_live_***REDACTED***',
    description: 'Stripe Secret Key (Live)',
  },
  {
    pattern: /\b(sk_test_[a-zA-Z0-9]{24,})\b/g,
    replacement: 'sk_test_***REDACTED***',
    description: 'Stripe Secret Key (Test)',
  },
  {
    pattern: /\b(rk_live_[a-zA-Z0-9]{24,})\b/g,
    replacement: 'rk_live_***REDACTED***',
    description: 'Stripe Restricted Key (Live)',
  },

  // WhatsApp tokens
  {
    pattern: /\bEAA[a-zA-Z0-9]{100,}\b/g,
    replacement: '***WHATSAPP_TOKEN***',
    description: 'WhatsApp/Meta Access Token',
  },

  // Generic 64-char hex (potential secrets)
  {
    pattern: /\b[a-f0-9]{64}\b/gi,
    replacement: '***HEX64_SECRET***',
    description: 'Generic 64-char hex secret',
  },

  // PEM private keys
  {
    pattern: /-----BEGIN[A-Z\s]+PRIVATE KEY-----[\s\S]*?-----END[A-Z\s]+PRIVATE KEY-----/g,
    replacement: '***PRIVATE_KEY***',
    description: 'PEM Private Key',
  },
];

// ログインジェクション対策のパターン
const INJECTION_PATTERNS: Array<{
  pattern: RegExp;
  replacement: string;
}> = [
  // CRLF injection
  { pattern: /\r\n/g, replacement: '\\r\\n' },
  { pattern: /\r/g, replacement: '\\r' },
  { pattern: /\n/g, replacement: '\\n' },

  // Control characters
  { pattern: /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, replacement: '' },

  // ANSI escape sequences
  { pattern: /\x1B\[[0-9;]*[A-Za-z]/g, replacement: '' },
];

/**
 * 文字列から機密情報をマスキング
 */
export function sanitize(input: string): string {
  let result = input;

  // 機密情報のマスキング
  for (const { pattern, replacement } of SENSITIVE_PATTERNS) {
    result = result.replace(pattern, replacement);
  }

  // ログインジェクション対策
  for (const { pattern, replacement } of INJECTION_PATTERNS) {
    result = result.replace(pattern, replacement);
  }

  return result;
}

/**
 * オブジェクトから機密情報をマスキング
 */
export function sanitizeObject<T>(obj: T, depth = 0): T {
  // 深さ制限（循環参照対策）
  if (depth > 10) {
    return '[MAX_DEPTH_EXCEEDED]' as unknown as T;
  }

  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj === 'string') {
    return sanitize(obj) as unknown as T;
  }

  if (typeof obj !== 'object') {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => sanitizeObject(item, depth + 1)) as unknown as T;
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    // センシティブなキー名の場合は値を完全にマスク（スカラー値のみ）
    const lowerKey = key.toLowerCase();
    const isSensitiveKey =
      lowerKey.includes('password') ||
      lowerKey.includes('secret') ||
      lowerKey.includes('token') ||
      lowerKey.includes('apikey') ||
      lowerKey.includes('api_key') ||
      lowerKey.includes('authorization') ||
      lowerKey.includes('credential');

    if (isSensitiveKey && (typeof value === 'string' || typeof value === 'number')) {
      // スカラー値の場合のみマスク
      result[key] = '***REDACTED***';
    } else {
      // オブジェクトや配列の場合は再帰的にサニタイズ
      result[key] = sanitizeObject(value, depth + 1);
    }
  }

  return result as T;
}

/**
 * 安全なログ出力ラッパー（構造化JSONログ対応）
 */
type LogLevel = 'info' | 'warn' | 'error' | 'debug';

function isLogLevel(value: unknown): value is LogLevel {
  return value === 'info' || value === 'warn' || value === 'error' || value === 'debug';
}

function emitLog(level: LogLevel, message: string, context?: unknown): void {
  const contextObj = typeof context === 'object' && context !== null && !Array.isArray(context)
    ? (context as Record<string, unknown>)
    : {};
  const structured = {
    timestamp: new Date().toISOString(),
    level,
    message: sanitize(message),
    ...sanitizeObject(contextObj),
  };
  const payload = JSON.stringify(structured);
  if (level === 'error') {
    console.error(payload);
  } else if (level === 'warn') {
    console.warn(payload);
  } else if (level === 'debug') {
    console.debug(payload);
  } else {
    // Use console.log so test spies and most log collectors see info-level logs consistently.
    console.log(payload);
  }
}

type SafeLogCallable = {
  (level: LogLevel, message: string, context?: unknown): void;
  (env: unknown, level: LogLevel, message: string, context?: unknown): void;
  log: (message: string, context?: unknown) => void;
  info: (message: string, context?: unknown) => void;
  warn: (message: string, context?: unknown) => void;
  error: (message: string, context?: unknown) => void;
  debug: (message: string, context?: unknown) => void;
};

export const safeLog: SafeLogCallable = ((
  arg1: unknown,
  arg2?: unknown,
  arg3?: unknown,
  arg4?: unknown
) => {
  if (typeof arg1 === 'string' && isLogLevel(arg1) && typeof arg2 === 'string') {
    emitLog(arg1, arg2, arg3);
    return;
  }

  if (isLogLevel(arg2) && typeof arg3 === 'string') {
    emitLog(arg2, arg3, arg4);
  }
}) as SafeLogCallable;

safeLog.log = (message: string, context?: unknown): void => emitLog('info', message, context);
safeLog.info = (message: string, context?: unknown): void => emitLog('info', message, context);
safeLog.warn = (message: string, context?: unknown): void => emitLog('warn', message, context);
safeLog.error = (message: string, context?: unknown): void => emitLog('error', message, context);
safeLog.debug = (message: string, context?: unknown): void => emitLog('debug', message, context);

/**
 * リクエストの識別子を安全に抽出（ログ用）
 */
export function getSafeRequestIdentifier(request: Request): string {
  const url = new URL(request.url);
  // パスのみを返す（クエリパラメータは含めない）
  return `${request.method} ${url.pathname}`;
}

/**
 * ユーザー識別子を安全にマスク
 */
export function maskUserId(userId: string): string {
  if (!userId || userId.length < 4) {
    return '***';
  }
  // 最初の2文字と最後の2文字のみ表示
  return `${userId.slice(0, 2)}***${userId.slice(-2)}`;
}

export default {
  sanitize,
  sanitizeObject,
  safeLog,
  getSafeRequestIdentifier,
  maskUserId,
};
