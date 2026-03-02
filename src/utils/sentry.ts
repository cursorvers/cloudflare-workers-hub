/**
 * Sentry Integration for Cloudflare Workers
 *
 * エラー監視・トレーシング・パフォーマンス計測
 * - withSentry ラッパーで SDK を初期化
 * - beforeSend で PII スクラブ
 * - ignoreErrors で Workers 特有ノイズをフィルタ
 */

import type { ErrorEvent } from '@sentry/cloudflare';
import {
  captureException as sentryCaptureException,
  captureMessage as sentryCaptureMessage,
  addBreadcrumb as sentryAddBreadcrumb,
  setUser as sentrySetUser,
  withScope,
} from '@sentry/cloudflare';
import { safeLog } from './log-sanitizer';

export interface SentryEnv {
  SENTRY_DSN?: string;
  SENTRY_RELEASE?: string;
  ENVIRONMENT?: string;
  DEPLOY_TARGET?: string;
}

/** Headers containing sensitive data that must be scrubbed */
const SENSITIVE_HEADERS = [
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-forwarded-for',
  'x-real-ip',
] as const;

/** Regex patterns for PII in request body (SSoT — keep in sync with fugue-system-ui) */
const PII_BODY_PATTERN =
  /"(password|token|secret|api_key|apiKey|access_token|refresh_token|client_secret|encryption_key|email)":\s*"[^"]*"/gi;

/**
 * Cloudflare Workers 特有のノイズエラー
 * 期限: 2026-09 に見直し (owner: masayuki)
 */
const WORKERS_IGNORE_ERRORS: Array<string | RegExp> = [
  'The script will never generate a response',
  /Error: Network connection lost/,
  /Error: The script exceeded the time limit/,
  /Error: Memory limit exceeded/,
  /AbortError: The operation was aborted/,
  /Error: internal error/,
  // D1 transient errors
  /D1_ERROR: no such table/,
];

/** Map DEPLOY_TARGET to Sentry environment */
function resolveEnvironment(env: SentryEnv): string {
  const target = env.DEPLOY_TARGET;
  if (target === 'canary') return 'canary';
  if (target === 'dev') return 'development';
  if (target === 'hub') return 'production';
  return env.ENVIRONMENT || 'unknown';
}

/** Resolve release string */
function resolveRelease(env: SentryEnv): string {
  return env.SENTRY_RELEASE || 'orchestrator-hub@unknown';
}

/** PII scrubbing for Sentry events (beforeSend) */
function scrubPii(event: ErrorEvent): ErrorEvent | null {
  // Scrub headers
  if (event.request?.headers) {
    for (const header of SENSITIVE_HEADERS) {
      if (event.request.headers[header]) {
        event.request.headers[header] = '[Filtered]';
      }
    }
  }

  // Scrub request body
  if (event.request?.data && typeof event.request.data === 'string') {
    event.request.data = event.request.data.replace(
      PII_BODY_PATTERN,
      '"$1": "[Filtered]"',
    );
  }

  return event;
}

/**
 * Create Sentry config object for withSentry wrapper.
 * Used by index.ts to initialize Sentry per-request.
 */
export function createSentryConfig(env: SentryEnv) {
  if (!env.SENTRY_DSN) {
    safeLog.warn('[Sentry] SENTRY_DSN not configured — error monitoring is disabled');
  }
  const environment = resolveEnvironment(env);
  return {
    dsn: env.SENTRY_DSN,
    environment,
    release: resolveRelease(env),
    tracesSampleRate: environment === 'production' ? 0.1 : 1.0,
    sendDefaultPii: false,
    ignoreErrors: WORKERS_IGNORE_ERRORS,
    beforeSend: scrubPii,
  };
}

/**
 * Capture exception with context
 */
export function captureException(
  error: Error,
  context?: Record<string, unknown>,
): void {
  withScope((scope) => {
    if (context) {
      scope.setExtras(context);
    }
    sentryCaptureException(error);
  });
}

/**
 * Capture message with level
 */
export function captureMessage(
  message: string,
  level: 'info' | 'warning' | 'error' = 'info',
): void {
  sentryCaptureMessage(message, level);
}

/**
 * Set user context
 */
export function setUser(user: {
  id: string;
  username?: string;
  source?: string;
}): void {
  sentrySetUser({
    id: user.id,
    username: user.username,
  });
}

/**
 * Add breadcrumb for debugging
 */
export function addBreadcrumb(
  category: string,
  message: string,
  data?: Record<string, unknown>,
): void {
  sentryAddBreadcrumb({
    category,
    message,
    data,
    level: 'info',
  });
}

export default {
  createSentryConfig,
  captureException,
  captureMessage,
  setUser,
  addBreadcrumb,
};
