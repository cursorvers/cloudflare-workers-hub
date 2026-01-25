/**
 * Sentry Integration for Cloudflare Workers
 *
 * エラー監視・トレーシング・パフォーマンス計測
 */

import {
  captureException as sentryCaptureException,
  captureMessage as sentryCaptureMessage,
  addBreadcrumb as sentryAddBreadcrumb,
  setUser as sentrySetUser,
  withScope,
} from '@sentry/cloudflare';

export interface SentryEnv {
  SENTRY_DSN?: string;
  ENVIRONMENT?: string;
}

/**
 * Capture exception with context
 */
export function captureException(
  error: Error,
  context?: Record<string, unknown>
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
  level: 'info' | 'warning' | 'error' = 'info'
): void {
  sentryCaptureMessage(message, level);
}

/**
 * Set user context
 */
export function setUser(user: { id: string; username?: string; source?: string }): void {
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
  data?: Record<string, unknown>
): void {
  sentryAddBreadcrumb({
    category,
    message,
    data,
    level: 'info',
  });
}

export default {
  captureException,
  captureMessage,
  setUser,
  addBreadcrumb,
};
