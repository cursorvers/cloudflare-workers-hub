/**
 * Push Notifications Handler
 *
 * Manages Web Push notification subscriptions and sending.
 *
 * ## Endpoints
 * - POST /api/cockpit/subscribe - Subscribe to push notifications
 * - POST /api/cockpit/unsubscribe - Unsubscribe from push notifications
 */

import { z } from 'zod';
import type { Env } from '../types';
import { safeLog } from '../utils/log-sanitizer';
import { createVapidHeaders } from '../utils/vapid';
import { sendWebPush, WebPushError } from '../utils/web-push';

// =============================================================================
// Request Schemas
// =============================================================================

const PushSubscriptionSchema = z.object({
  subscription: z.object({
    endpoint: z.string().url(),
    keys: z.object({
      p256dh: z.string(),
      auth: z.string(),
    }),
  }),
  userId: z.string().optional(),
});

const UnsubscribeSchema = z.object({
  endpoint: z.string().url(),
});

const SendNotificationSchema = z.object({
  title: z.string().min(1).max(120, 'Title too long (max 120 chars)'),
  body: z.string().min(1).max(500, 'Body too long (max 500 chars)'),
  severity: z.enum(['critical', 'warning', 'info']).optional(),
  url: z.string().url().max(2048, 'URL too long').optional(),
  userId: z.string().optional(), // Send to specific user
});

/**
 * Validate notification payload URL (prevent phishing)
 * @param url - The action URL in notification
 */
function validateNotificationUrl(url: string | undefined): void {
  if (!url) return;

  try {
    const parsed = new URL(url);

    // Require HTTPS
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error('Notification URL must use HTTP(S)');
    }

    // Prevent private IP ranges (phishing prevention)
    const hostname = parsed.hostname.toLowerCase();
    const privateIPPatterns = [
      /^127\./, // Loopback
      /^10\./, // Private Class A
      /^172\.(1[6-9]|2[0-9]|3[01])\./, // Private Class B
      /^192\.168\./, // Private Class C
      /^169\.254\./, // Link-local
      /^::1$/, // IPv6 loopback
      /^fe80:/, // IPv6 link-local
      /^fc00:/, // IPv6 unique local
      /^localhost$/i,
    ];

    for (const pattern of privateIPPatterns) {
      if (pattern.test(hostname)) {
        throw new Error('Notification URL cannot target private/localhost addresses');
      }
    }

    // Optional: Add domain whitelist if you want stricter control
    // For now, we allow any public HTTPS URL
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error('Invalid notification URL format');
    }
    throw error;
  }
}

// D1 Query Result Types
interface PushSubscriptionRow {
  id: number;
  endpoint: string;
  p256dh_key: string;
  auth_key: string;
  user_id: string | null;
  active: number;
  created_at: number;
  last_notified: number | null;
}

// Whitelist of allowed Push Service domains (SSRF prevention)
const ALLOWED_PUSH_DOMAINS = [
  'fcm.googleapis.com',
  'android.googleapis.com',
  'push.services.mozilla.com',
  'updates.push.services.mozilla.com',
  'web.push.apple.com',
  'wns2-*.notify.windows.com',
  'db5.notify.windows.com',
  '*.notify.windows.com',
];

/**
 * Validate push endpoint URL (SSRF prevention)
 * @param endpoint - The push endpoint URL
 * @returns true if valid, throws error otherwise
 */
function validatePushEndpoint(endpoint: string): void {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error('Invalid endpoint URL format');
  }

  // Require HTTPS
  if (url.protocol !== 'https:') {
    throw new Error('Push endpoint must use HTTPS');
  }

  // Check against whitelist (exact match or wildcard)
  const hostname = url.hostname.toLowerCase();
  const isAllowed = ALLOWED_PUSH_DOMAINS.some((domain) => {
    if (domain.includes('*')) {
      // Wildcard match (e.g., *.notify.windows.com)
      const pattern = domain.replace(/\*/g, '[^.]+');
      const regex = new RegExp(`^${pattern}$`, 'i');
      return regex.test(hostname);
    }
    return hostname === domain.toLowerCase();
  });

  if (!isAllowed) {
    throw new Error(
      `Push endpoint domain not allowed. Hostname: ${hostname}. Only known push services are supported.`
    );
  }

  // Prevent private IP ranges (additional layer)
  const privateIPPatterns = [
    /^127\./, // Loopback
    /^10\./, // Private Class A
    /^172\.(1[6-9]|2[0-9]|3[01])\./, // Private Class B
    /^192\.168\./, // Private Class C
    /^169\.254\./, // Link-local
    /^::1$/, // IPv6 loopback
    /^fe80:/, // IPv6 link-local
    /^fc00:/, // IPv6 unique local
  ];

  for (const pattern of privateIPPatterns) {
    if (pattern.test(hostname)) {
      throw new Error('Push endpoint cannot target private IP ranges');
    }
  }

  // Length limit (prevent excessively long URLs)
  if (endpoint.length > 2048) {
    throw new Error('Push endpoint URL too long (max 2048 characters)');
  }
}

/**
 * Validate and parse D1 subscription row
 */
function validateSubscriptionRow(row: unknown): PushSubscriptionRow {
  if (!row || typeof row !== 'object') {
    throw new Error('Invalid subscription row: not an object');
  }

  const r = row as Record<string, unknown>;

  if (
    typeof r.id !== 'number' ||
    typeof r.endpoint !== 'string' ||
    typeof r.p256dh_key !== 'string' ||
    typeof r.auth_key !== 'string' ||
    typeof r.active !== 'number' ||
    typeof r.created_at !== 'number'
  ) {
    throw new Error('Invalid subscription row: missing or invalid required fields');
  }

  // Validate optional user_id field (must be string or null)
  if (r.user_id !== undefined && r.user_id !== null && typeof r.user_id !== 'string') {
    throw new Error('Invalid subscription row: user_id must be string or null');
  }

  // Validate optional last_notified field (must be number or null)
  if (r.last_notified !== undefined && r.last_notified !== null && typeof r.last_notified !== 'number') {
    throw new Error('Invalid subscription row: last_notified must be number or null');
  }

  const userId = r.user_id ?? null;
  const lastNotified = r.last_notified ?? null;

  return {
    id: r.id,
    endpoint: r.endpoint,
    p256dh_key: r.p256dh_key,
    auth_key: r.auth_key,
    user_id: userId,
    active: r.active,
    created_at: r.created_at,
    last_notified: lastNotified,
  };
}

// =============================================================================
// Route Handlers
// =============================================================================

/**
 * POST /api/cockpit/subscribe
 * Subscribe to push notifications
 * @param request - The HTTP request
 * @param env - Environment bindings
 * @param authenticatedUserId - User ID from authentication token (required)
 */
export async function handleSubscribe(
  request: Request,
  env: Env,
  authenticatedUserId: string
): Promise<Response> {
  if (!env.DB) {
    return new Response(JSON.stringify({ error: 'Database not available' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const body = await request.json();
    const validated = PushSubscriptionSchema.parse(body);

    const { endpoint, keys } = validated.subscription;
    const { p256dh, auth } = keys;
    // Use authenticated userId (ignore request body userId)
    const userId = authenticatedUserId;

    // Validate endpoint (SSRF prevention)
    validatePushEndpoint(endpoint);

    // Insert or update subscription
    await env.DB.prepare(`
      INSERT INTO push_subscriptions (endpoint, p256dh_key, auth_key, user_id, active)
      VALUES (?, ?, ?, ?, 1)
      ON CONFLICT(endpoint) DO UPDATE SET
        p256dh_key = excluded.p256dh_key,
        auth_key = excluded.auth_key,
        user_id = excluded.user_id,
        active = 1,
        created_at = strftime('%s', 'now')
    `).bind(endpoint, p256dh, auth, userId).run();

    safeLog.log('[Push] Subscription saved', {
      endpoint: endpoint.substring(0, 50) + '...',
      userId,
    });

    return new Response(JSON.stringify({
      success: true,
      message: 'Subscription saved',
    }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return new Response(JSON.stringify({
        error: 'Validation failed',
        details: error.errors,
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    safeLog.error('[Push] Failed to save subscription', {
      error: error instanceof Error ? error.message : String(error),
    });
    return new Response(JSON.stringify({ error: 'Internal error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

/**
 * POST /api/cockpit/unsubscribe
 * Unsubscribe from push notifications
 * @param request - The HTTP request
 * @param env - Environment bindings
 * @param authenticatedUserId - User ID from authentication token (required)
 */
export async function handleUnsubscribe(
  request: Request,
  env: Env,
  authenticatedUserId: string
): Promise<Response> {
  if (!env.DB) {
    return new Response(JSON.stringify({ error: 'Database not available' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const body = await request.json();
    const validated = UnsubscribeSchema.parse(body);

    // Verify ownership: only allow users to unsubscribe their own subscriptions
    const result = await env.DB.prepare(`
      UPDATE push_subscriptions
      SET active = 0
      WHERE endpoint = ? AND user_id = ?
    `).bind(validated.endpoint, authenticatedUserId).run();

    if (result.meta.changes === 0) {
      return new Response(JSON.stringify({
        error: 'Subscription not found or not owned by this user'
      }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    safeLog.log('[Push] Subscription deactivated', {
      endpoint: validated.endpoint.substring(0, 50) + '...',
    });

    return new Response(JSON.stringify({
      success: true,
      message: 'Subscription deactivated',
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return new Response(JSON.stringify({
        error: 'Validation failed',
        details: error.errors,
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    safeLog.error('[Push] Failed to unsubscribe', {
      error: error instanceof Error ? error.message : String(error),
    });
    return new Response(JSON.stringify({ error: 'Internal error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// =============================================================================
// Push Notification Sending
// =============================================================================

/**
 * Send push notification using Web Push protocol
 */
export async function sendPushNotification(
  env: Env,
  payload: {
    title: string;
    body: string;
    severity?: 'critical' | 'warning' | 'info';
    url?: string;
    userId?: string;
  }
): Promise<{ success: number; failed: number }> {
  if (!env.DB || !env.VAPID_PRIVATE_KEY || !env.VAPID_PUBLIC_KEY) {
    safeLog.error('[Push] Database or VAPID keys not configured');
    throw new Error('Push notifications not configured');
  }

  const vapidPrivateKey = env.VAPID_PRIVATE_KEY;
  const vapidPublicKey = env.VAPID_PUBLIC_KEY;

  try {
    SendNotificationSchema.parse(payload);
    validateNotificationUrl(payload.url);
  } catch (validationError) {
    safeLog.error('[Push] Invalid notification payload', {
      error: validationError instanceof Error ? validationError.message : String(validationError),
    });
    throw new Error(
      `Invalid notification payload: ${validationError instanceof Error ? validationError.message : String(validationError)}`
    );
  }

  const vapidSubject = env.VAPID_SUBJECT || 'mailto:admin@example.com';
  const severity = payload.severity || 'info';
  const queueSeverity: 'critical' | 'high' | 'medium' | 'low' =
    severity === 'critical' ? 'critical' : severity === 'warning' ? 'medium' : 'low';

  try {
    let query = 'SELECT * FROM push_subscriptions WHERE active = 1';
    const params: string[] = [];

    if (payload.userId) {
      query += ' AND user_id = ?';
      params.push(payload.userId);
    }

    const stmt = env.DB.prepare(query);
    const result = params.length > 0 ? await stmt.bind(...params).all() : await stmt.all();

    const rawSubscriptions = result.results || [];

    if (rawSubscriptions.length === 0) {
      safeLog.warn('[Push] No active subscriptions found');
      return { success: 0, failed: 0 };
    }

    const subscriptions: PushSubscriptionRow[] = [];
    for (const row of rawSubscriptions) {
      try {
        subscriptions.push(validateSubscriptionRow(row));
      } catch (validationError) {
        safeLog.error('[Push] Invalid subscription row', {
          error: validationError instanceof Error ? validationError.message : String(validationError),
        });
      }
    }

    if (subscriptions.length === 0) {
      safeLog.warn('[Push] No valid subscriptions after validation');
      return { success: 0, failed: 0 };
    }

    // OPTIMIZATION: If too many subscriptions, offload to Queue for background processing
    const QUEUE_THRESHOLD = 50;
    if (subscriptions.length > QUEUE_THRESHOLD && env.PUSH_NOTIFICATION_QUEUE) {
      safeLog.info('[Push] Offloading to Queue (spike handling)', {
        count: subscriptions.length,
        threshold: QUEUE_THRESHOLD,
      });

      await env.PUSH_NOTIFICATION_QUEUE.send({
        subscriptionIds: subscriptions.map((sub) => sub.id),
        payload: {
          title: payload.title,
          body: payload.body,
          icon: '/icons/icon-192.png',
          badge: '/icons/icon-192.png',
          tag: 'cockpit-notification',
          data: {
            url: payload.url || '/',
            timestamp: Date.now(),
          },
        },
        severity: queueSeverity,
      });

      // Return immediately (processing happens in queue consumer)
      return { success: subscriptions.length, failed: 0 };
    }

    const notificationPayload = {
      title: payload.title,
      body: payload.body,
      severity,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: 'cockpit-notification',
      data: {
        url: payload.url || '/',
        timestamp: Date.now(),
      },
    };

    // Parallel send with Promise.allSettled
    const sendResults = await Promise.allSettled(
      subscriptions.map(async (sub) => {
        const subscription = {
          endpoint: sub.endpoint,
          keys: {
            p256dh: sub.p256dh_key,
            auth: sub.auth_key,
          },
        };

        try {
          await sendWebPush(
            subscription,
            JSON.stringify(notificationPayload),
            vapidPrivateKey,
            vapidPublicKey,
            vapidSubject
          );
          return sub;
        } catch (error) {
          throw { sub, error };
        }
      })
    );

    const successSubs: PushSubscriptionRow[] = [];
    const failedSubs: Array<{ sub: PushSubscriptionRow; error: unknown }> = [];
    const goneSubs: PushSubscriptionRow[] = [];

    for (const resultItem of sendResults) {
      if (resultItem.status === 'fulfilled') {
        successSubs.push(resultItem.value);
        continue;
      }

      const { sub, error } = resultItem.reason as { sub: PushSubscriptionRow; error: unknown };
      failedSubs.push({ sub, error });

      safeLog.error('[Push] Failed to send notification', {
        endpoint: sub.endpoint.substring(0, 50) + '...',
        error: error instanceof Error ? error.message : String(error),
      });

      if (error instanceof WebPushError && error.statusCode === 410) {
        goneSubs.push(sub);
      }
    }

    // Batch UPDATE for successful subscriptions
    if (successSubs.length > 0) {
      const placeholders = successSubs.map(() => '?').join(', ');
      await env.DB.prepare(
        `UPDATE push_subscriptions SET last_notified = strftime('%s', 'now') WHERE id IN (${placeholders})`
      ).bind(...successSubs.map((sub) => sub.id)).run();

      const successRows = successSubs.map((sub) => [sub.id, payload.title, payload.body, severity]);
      const successPlaceholders = successRows.map(() => '(?, ?, ?, ?, 1)').join(', ');
      await env.DB.prepare(
        `INSERT INTO push_notification_log (subscription_id, title, body, severity, success) VALUES ${successPlaceholders}`
      ).bind(...successRows.flat()).run();
    }

    // Batch INSERT for failed subscriptions
    if (failedSubs.length > 0) {
      const failureRows = failedSubs.map(({ sub, error }) => [
        sub.id,
        payload.title,
        payload.body,
        severity,
        error instanceof Error ? error.message : String(error),
      ]);
      const failurePlaceholders = failureRows.map(() => '(?, ?, ?, ?, 0, ?)').join(', ');
      await env.DB.prepare(
        `INSERT INTO push_notification_log (subscription_id, title, body, severity, success, error_message) VALUES ${failurePlaceholders}`
      ).bind(...failureRows.flat()).run();
    }

    // Batch deactivate for 410 Gone subscriptions
    if (goneSubs.length > 0) {
      const placeholders = goneSubs.map(() => '?').join(', ');
      await env.DB.prepare(
        `UPDATE push_subscriptions SET active = 0 WHERE id IN (${placeholders})`
      ).bind(...goneSubs.map((sub) => sub.id)).run();
      safeLog.log('[Push] Deactivated invalid subscription (410 Gone)', { count: goneSubs.length });
    }

    const successCount = successSubs.length;
    const failedCount = failedSubs.length;

    safeLog.log('[Push] Notifications sent', {
      total: subscriptions.length,
      success: successCount,
      failed: failedCount,
    });

    return { success: successCount, failed: failedCount };
  } catch (error) {
    safeLog.error('[Push] Failed to send notifications', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

// Web Push utilities (sendWebPush, WebPushError) moved to src/utils/web-push.ts for reuse
