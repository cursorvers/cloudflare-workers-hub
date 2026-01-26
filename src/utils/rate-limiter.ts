/**
 * Rate Limiter
 *
 * チャネル別のレート制限を実装
 * Cloudflare Workers KV を使用したスライディングウィンドウ方式
 */

import { Env } from '../types';

export interface RateLimitConfig {
  windowMs: number; // Time window in milliseconds
  maxRequests: number; // Maximum requests per window
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
  retryAfter?: number;
}

// チャネル別のレート制限設定
const RATE_LIMITS: Record<string, RateLimitConfig> = {
  // Webhook channels
  slack: { windowMs: 60000, maxRequests: 100 }, // 100 req/min
  discord: { windowMs: 60000, maxRequests: 100 }, // 100 req/min
  telegram: { windowMs: 60000, maxRequests: 60 }, // 60 req/min
  whatsapp: { windowMs: 60000, maxRequests: 60 }, // 60 req/min
  clawdbot: { windowMs: 60000, maxRequests: 120 }, // 120 req/min
  // Internal API scopes (stricter limits)
  queue: { windowMs: 60000, maxRequests: 60 }, // 60 req/min (1 req/sec avg)
  memory: { windowMs: 60000, maxRequests: 120 }, // 120 req/min (2 req/sec avg)
  admin: { windowMs: 60000, maxRequests: 10 }, // 10 req/min (admin ops are rare)
  // Limitless webhook (iPhone trigger)
  limitless_webhook_auth: { windowMs: 60000, maxRequests: 60 }, // 60 req/min with auth
  limitless_webhook_public: { windowMs: 60000, maxRequests: 10 }, // 10 req/min without auth (prevent abuse)
  // Default fallback
  default: { windowMs: 60000, maxRequests: 30 }, // 30 req/min
};

/**
 * インメモリ用のレート制限ストア（KV がない場合のフォールバック）
 */
const inMemoryStore = new Map<string, { count: number; resetAt: number }>();

/**
 * インメモリストアのクリーンアップ
 */
function cleanupInMemoryStore(): void {
  const now = Date.now();
  for (const [key, value] of inMemoryStore.entries()) {
    if (value.resetAt < now) {
      inMemoryStore.delete(key);
    }
  }
}

/**
 * レート制限チェック（KV 使用）
 */
async function checkRateLimitWithKV(
  cache: KVNamespace,
  key: string,
  config: RateLimitConfig
): Promise<RateLimitResult> {
  const now = Date.now();
  const windowStart = now - config.windowMs;

  // KV からカウンターを取得
  const stored = await cache.get<{ requests: number[]; }>(key, 'json');

  // 有効なリクエストタイムスタンプのみをフィルタ
  const requests = stored?.requests?.filter((ts) => ts > windowStart) || [];

  if (requests.length >= config.maxRequests) {
    const oldestRequest = Math.min(...requests);
    const retryAfter = Math.ceil((oldestRequest + config.windowMs - now) / 1000);

    return {
      allowed: false,
      remaining: 0,
      resetAt: oldestRequest + config.windowMs,
      retryAfter: Math.max(1, retryAfter),
    };
  }

  // 新しいリクエストを追加
  requests.push(now);

  // KV に保存（TTL は window の2倍）
  await cache.put(key, JSON.stringify({ requests }), {
    expirationTtl: Math.ceil((config.windowMs * 2) / 1000),
  });

  return {
    allowed: true,
    remaining: config.maxRequests - requests.length,
    resetAt: now + config.windowMs,
  };
}

/**
 * レート制限チェック（インメモリ）
 */
function checkRateLimitInMemory(
  key: string,
  config: RateLimitConfig
): RateLimitResult {
  const now = Date.now();

  // 定期的にクリーンアップ
  if (Math.random() < 0.01) {
    cleanupInMemoryStore();
  }

  const stored = inMemoryStore.get(key);

  if (!stored || stored.resetAt < now) {
    // 新しいウィンドウを開始
    inMemoryStore.set(key, { count: 1, resetAt: now + config.windowMs });
    return {
      allowed: true,
      remaining: config.maxRequests - 1,
      resetAt: now + config.windowMs,
    };
  }

  if (stored.count >= config.maxRequests) {
    const retryAfter = Math.ceil((stored.resetAt - now) / 1000);
    return {
      allowed: false,
      remaining: 0,
      resetAt: stored.resetAt,
      retryAfter: Math.max(1, retryAfter),
    };
  }

  stored.count++;
  return {
    allowed: true,
    remaining: config.maxRequests - stored.count,
    resetAt: stored.resetAt,
  };
}

/**
 * レート制限をチェック
 */
export async function checkRateLimit(
  env: Env,
  channel: string,
  identifier: string
): Promise<RateLimitResult> {
  const config = RATE_LIMITS[channel] || RATE_LIMITS.default;
  const key = `ratelimit:${channel}:${identifier}`;

  if (env.CACHE) {
    try {
      return await checkRateLimitWithKV(env.CACHE, key, config);
    } catch {
      // KV failure (e.g., daily put limit exceeded) — fall back to in-memory
      return checkRateLimitInMemory(key, config);
    }
  }

  return checkRateLimitInMemory(key, config);
}

/**
 * レート制限レスポンスを生成
 */
export function createRateLimitResponse(result: RateLimitResult): Response {
  return new Response(
    JSON.stringify({
      error: 'Too Many Requests',
      retryAfter: result.retryAfter,
      resetAt: new Date(result.resetAt).toISOString(),
    }),
    {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': String(result.retryAfter),
        'X-RateLimit-Remaining': '0',
        'X-RateLimit-Reset': String(Math.ceil(result.resetAt / 1000)),
      },
    }
  );
}

/**
 * レート制限ヘッダーを追加
 */
export function addRateLimitHeaders(
  response: Response,
  result: RateLimitResult
): Response {
  const headers = new Headers(response.headers);
  headers.set('X-RateLimit-Remaining', String(result.remaining));
  headers.set('X-RateLimit-Reset', String(Math.ceil(result.resetAt / 1000)));

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  checkRateLimit,
  createRateLimitResponse,
  addRateLimitHeaders,
};
