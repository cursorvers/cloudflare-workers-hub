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
  title: z.string().min(1),
  body: z.string(),
  severity: z.enum(['critical', 'warning', 'info']).optional(),
  url: z.string().url().optional(),
  userId: z.string().optional(), // Send to specific user
});

// =============================================================================
// Route Handlers
// =============================================================================

/**
 * POST /api/cockpit/subscribe
 * Subscribe to push notifications
 */
export async function handleSubscribe(request: Request, env: Env): Promise<Response> {
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
    const userId = validated.userId || null;

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
 */
export async function handleUnsubscribe(request: Request, env: Env): Promise<Response> {
  if (!env.DB) {
    return new Response(JSON.stringify({ error: 'Database not available' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const body = await request.json();
    const validated = UnsubscribeSchema.parse(body);

    const result = await env.DB.prepare(`
      UPDATE push_subscriptions
      SET active = 0
      WHERE endpoint = ?
    `).bind(validated.endpoint).run();

    if (result.meta.changes === 0) {
      return new Response(JSON.stringify({ error: 'Subscription not found' }), {
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
  if (!env.DB || !env.VAPID_PRIVATE_KEY) {
    safeLog.error('[Push] Database or VAPID keys not configured');
    throw new Error('Push notifications not configured');
  }

  try {
    // Get active subscriptions
    let query = 'SELECT * FROM push_subscriptions WHERE active = 1';
    const params: string[] = [];

    if (payload.userId) {
      query += ' AND user_id = ?';
      params.push(payload.userId);
    }

    const stmt = env.DB.prepare(query);
    const result = params.length > 0 ? await stmt.bind(...params).all() : await stmt.all();

    const subscriptions = result.results || [];

    if (subscriptions.length === 0) {
      safeLog.warn('[Push] No active subscriptions found');
      return { success: 0, failed: 0 };
    }

    // Prepare notification payload
    const notificationPayload = {
      title: payload.title,
      body: payload.body,
      severity: payload.severity || 'info',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: 'cockpit-notification',
      data: {
        url: payload.url || '/',
        timestamp: Date.now(),
      },
    };

    let successCount = 0;
    let failedCount = 0;

    // Send to each subscription
    for (const sub of subscriptions) {
      try {
        const subscription = {
          endpoint: sub.endpoint as string,
          keys: {
            p256dh: sub.p256dh_key as string,
            auth: sub.auth_key as string,
          },
        };

        await sendWebPush(
          subscription,
          JSON.stringify(notificationPayload),
          env.VAPID_PRIVATE_KEY,
          env.VAPID_PUBLIC_KEY || ''
        );

        successCount++;

        // Update last_notified timestamp
        await env.DB.prepare(`
          UPDATE push_subscriptions
          SET last_notified = strftime('%s', 'now')
          WHERE id = ?
        `).bind(sub.id).run();

        // Log notification (optional)
        await env.DB.prepare(`
          INSERT INTO push_notification_log (subscription_id, title, body, severity, success)
          VALUES (?, ?, ?, ?, 1)
        `).bind(
          sub.id,
          payload.title,
          payload.body,
          payload.severity || 'info'
        ).run();

      } catch (error) {
        failedCount++;

        safeLog.error('[Push] Failed to send notification', {
          endpoint: (sub.endpoint as string).substring(0, 50) + '...',
          error: error instanceof Error ? error.message : String(error),
        });

        // Log failed notification
        await env.DB.prepare(`
          INSERT INTO push_notification_log (subscription_id, title, body, severity, success, error_message)
          VALUES (?, ?, ?, ?, 0, ?)
        `).bind(
          sub.id,
          payload.title,
          payload.body,
          payload.severity || 'info',
          error instanceof Error ? error.message : String(error)
        ).run();

        // Deactivate if endpoint is gone (410 Gone)
        if (error instanceof Error && error.message.includes('410')) {
          await env.DB.prepare(`
            UPDATE push_subscriptions
            SET active = 0
            WHERE id = ?
          `).bind(sub.id).run();
          safeLog.log('[Push] Deactivated invalid subscription');
        }
      }
    }

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

/**
 * Send Web Push using native fetch
 * Implements Web Push Protocol (RFC 8030)
 */
async function sendWebPush(
  subscription: {
    endpoint: string;
    keys: { p256dh: string; auth: string };
  },
  payload: string,
  vapidPrivateKey: string,
  vapidPublicKey: string
): Promise<void> {
  // Generate VAPID headers (simplified - in production use a proper library)
  const vapidHeaders = {
    'Content-Type': 'application/json',
    'TTL': '3600',
    'Urgency': 'high',
    // In production, implement proper VAPID JWT signing
    // For now, this is a placeholder
  };

  const response = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: vapidHeaders,
    body: payload,
  });

  if (!response.ok) {
    throw new Error(`Push failed: ${response.status} ${response.statusText}`);
  }
}
