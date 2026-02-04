/**
 * Push Notification Queue Consumer
 *
 * Processes bulk push notifications from Cloudflare Queues.
 * Triggered automatically when messages are added to the queue.
 *
 * ## Queue Configuration
 * - max_batch_size: 50 (process up to 50 subscriptions per batch)
 * - max_batch_timeout: 5 seconds
 * - max_retries: 3
 * - dead_letter_queue: push-notifications-dlq
 *
 * ## Flow
 * 1. Receive batch of subscription IDs + notification payload
 * 2. Fetch subscription details from D1
 * 3. Send push notifications in parallel
 * 4. Update database with results
 * 5. Ack successful messages, retry failed ones
 */

import type { Env, PushNotificationQueueMessage } from '../types';
import { safeLog } from '../utils/log-sanitizer';
import { sendWebPush, WebPushError } from '../utils/web-push';

interface PushSubscriptionRow {
  id: number;
  endpoint: string;
  p256dh_key: string;
  auth_key: string;
  user_id: string | null;
  active: number;
  created_at: string;
  last_notified: string | null;
}

/**
 * Queue Consumer Handler
 */
export async function handlePushQueueBatch(
  batch: MessageBatch<PushNotificationQueueMessage>,
  env: Env
): Promise<void> {
  safeLog.info('[PushQueueConsumer] Processing batch', {
    batchSize: batch.messages.length,
  });

  const vapidPrivateKey = env.VAPID_PRIVATE_KEY;
  const vapidPublicKey = env.VAPID_PUBLIC_KEY;
  const vapidSubject = env.VAPID_SUBJECT || 'mailto:admin@example.com';

  if (!vapidPrivateKey || !vapidPublicKey) {
    safeLog.error('[PushQueueConsumer] VAPID keys not configured');
    // Retry all messages
    batch.messages.forEach((msg) => msg.retry());
    return;
  }

  // Process each message in the batch
  for (const message of batch.messages) {
    try {
      const { subscriptionIds, payload, severity } = message.body;

      if (!subscriptionIds || subscriptionIds.length === 0) {
        safeLog.warn('[PushQueueConsumer] Empty subscription IDs', {
          messageId: message.id,
        });
        message.ack(); // Ack invalid messages
        continue;
      }

      // Fetch subscriptions from D1
      const placeholders = subscriptionIds.map(() => '?').join(', ');
      const { results } = await env.DB!.prepare(
        `SELECT * FROM push_subscriptions WHERE id IN (${placeholders}) AND active = 1`
      )
        .bind(...subscriptionIds)
        .all<PushSubscriptionRow>();

      if (!results || results.length === 0) {
        safeLog.warn('[PushQueueConsumer] No active subscriptions found', {
          messageId: message.id,
          subscriptionIds,
        });
        message.ack();
        continue;
      }

      // Prepare notification payload
      const notificationPayload = {
        title: payload.title,
        body: payload.body,
        icon: payload.icon || '/icon-192.png',
        badge: payload.badge || '/badge-72.png',
        tag: payload.tag || 'push-notification',
        data: payload.data || {},
      };

      // Send push notifications in parallel
      const sendResults = await Promise.allSettled(
        results.map(async (sub) => {
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

      // Categorize results
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

        safeLog.error('[PushQueueConsumer] Failed to send notification', {
          endpoint: sub.endpoint.substring(0, 50) + '...',
          error: error instanceof Error ? error.message : String(error),
        });

        if (error instanceof WebPushError && error.statusCode === 410) {
          goneSubs.push(sub);
        }
      }

      // Batch UPDATE for successful subscriptions
      if (successSubs.length > 0) {
        const successPlaceholders = successSubs.map(() => '?').join(', ');
        await env.DB!.prepare(
          `UPDATE push_subscriptions SET last_notified = strftime('%s', 'now') WHERE id IN (${successPlaceholders})`
        )
          .bind(...successSubs.map((sub) => sub.id))
          .run();

        const successRows = successSubs.map((sub) => [sub.id, payload.title, payload.body, severity]);
        const successLogPlaceholders = successRows.map(() => '(?, ?, ?, ?, 1)').join(', ');
        await env.DB!.prepare(
          `INSERT INTO push_notification_log (subscription_id, title, body, severity, success) VALUES ${successLogPlaceholders}`
        )
          .bind(...successRows.flat())
          .run();

        safeLog.info('[PushQueueConsumer] Sent notifications successfully', {
          count: successSubs.length,
        });
      }

      // Batch DELETE for 410 Gone subscriptions
      if (goneSubs.length > 0) {
        const gonePlaceholders = goneSubs.map(() => '?').join(', ');
        await env.DB!.prepare(
          `DELETE FROM push_subscriptions WHERE id IN (${gonePlaceholders})`
        )
          .bind(...goneSubs.map((sub) => sub.id))
          .run();

        safeLog.info('[PushQueueConsumer] Cleaned up expired subscriptions', {
          count: goneSubs.length,
        });
      }

      // Log failed subscriptions (retry later)
      if (failedSubs.length > 0) {
        const failedRows = failedSubs.map(({ sub }) => [sub.id, payload.title, payload.body, severity]);
        const failedLogPlaceholders = failedRows.map(() => '(?, ?, ?, ?, 0)').join(', ');
        await env.DB!.prepare(
          `INSERT INTO push_notification_log (subscription_id, title, body, severity, success) VALUES ${failedLogPlaceholders}`
        )
          .bind(...failedRows.flat())
          .run();

        safeLog.warn('[PushQueueConsumer] Some notifications failed', {
          count: failedSubs.length,
        });
      }

      // Ack the message if all processing completed
      message.ack();
    } catch (error) {
      safeLog.error('[PushQueueConsumer] Message processing failed', {
        messageId: message.id,
        error: error instanceof Error ? error.message : String(error),
      });

      // Retry the message
      message.retry();
    }
  }
}
