/**
 * Scheduled Reflection Notification Handler (Limitless Phase 5)
 *
 * Sends notifications for highlights created 24+ hours ago that are still
 * pending review.
 *
 * Triggered by CRON_DAILY_ACTIONS (0 21 * * * = 6AM JST)
 */

import { Env } from '../types';
import { safeLog } from '../utils/log-sanitizer';
import { supabaseSelect, supabaseUpdate, type SupabaseConfig } from '../services/supabase-client';
import {
  sendMultiChannelNotification,
  type NotificationChannel,
  type ReflectionNotification,
} from '../services/reflection-notifier';

/**
 * Send reflection notifications for highlights created 24+ hours ago.
 * Runs with distributed locking to prevent duplicate notifications.
 */
export async function handleReflectionNotifications(
  env: Env,
  withLock: typeof import('./scheduled').withLock
): Promise<void> {
  const lockKey = 'limitless:reflection_notifications_lock';

  await withLock(env.CACHE!, lockKey, 300, async () => {
    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
      safeLog.warn('[ReflectionNotifications] Supabase not configured, skipping');
      return;
    }

    if (!env.DISCORD_WEBHOOK_URL && !env.SLACK_WEBHOOK_URL) {
      safeLog.warn('[ReflectionNotifications] No notification channels configured, skipping');
      return;
    }

    const config: SupabaseConfig = {
      url: env.SUPABASE_URL,
      serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
    };

    // Find highlights created 24+ hours ago that are still pending review
    const now = new Date();
    const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const fortyEightHoursAgo = new Date(now.getTime() - 48 * 60 * 60 * 1000);

    const periodStartISO = fortyEightHoursAgo.toISOString();
    const periodEndISO = twentyFourHoursAgo.toISOString();

    safeLog.info('[ReflectionNotifications] Checking for pending highlights', {
      periodStart: periodStartISO,
      periodEnd: periodEndISO,
    });

    // Query highlights that:
    // - Created 24-48 hours ago
    // - Status is 'pending_review'
    // - Not yet notified (notified_at IS NULL)
    const selectFields = 'id,highlight_time,extracted_text,speaker_name,topics,processing_metadata';
    const query = `select=${selectFields}&highlight_time=gte.${periodStartISO}&highlight_time=lt.${periodEndISO}&status=eq.pending_review&notified_at=is.null&order=highlight_time.asc&limit=50`;

    const { data: highlights, error } = await supabaseSelect<{
      id: string;
      highlight_time: string;
      extracted_text?: string;
      speaker_name?: string;
      topics: string[];
      processing_metadata?: { notification_url?: string };
    }>(config, 'lifelog_highlights', query);

    if (error) {
      safeLog.error('[ReflectionNotifications] Failed to fetch highlights', {
        error: error.message,
      });
      return;
    }

    if (!highlights || highlights.length === 0) {
      safeLog.info('[ReflectionNotifications] No highlights pending notification');
      return;
    }

    safeLog.info('[ReflectionNotifications] Found highlights to notify', {
      count: highlights.length,
    });

    // Determine notification channels
    const channels: NotificationChannel[] = [];
    if (env.DISCORD_WEBHOOK_URL) channels.push('discord');
    if (env.SLACK_WEBHOOK_URL) channels.push('slack');

    // Send notifications for each highlight
    let successCount = 0;
    let errorCount = 0;

    for (const highlight of highlights) {
      try {
        const notification: ReflectionNotification = {
          highlight_id: highlight.id,
          highlight_time: highlight.highlight_time,
          extracted_text: highlight.extracted_text || null,
          speaker_name: highlight.speaker_name || null,
          topics: highlight.topics || [],
          notification_url:
            highlight.processing_metadata?.notification_url ||
            `${env.SUPABASE_URL || 'http://localhost:8787'}/api/limitless/reflection?highlight_id=${highlight.id}`,
        };

        const results = await sendMultiChannelNotification(env, channels, notification, false);

        const anySuccess = results.some((r) => r.success);

        if (anySuccess) {
          // Update highlight with notification timestamp
          const { error: updateError } = await supabaseUpdate(
            config,
            'lifelog_highlights',
            { notified_at: new Date().toISOString() },
            `id=eq.${highlight.id}`
          );

          if (updateError) {
            safeLog.warn('[ReflectionNotifications] Failed to update notified_at', {
              highlight_id: highlight.id,
              error: updateError.message,
            });
          }

          successCount++;

          safeLog.info('[ReflectionNotifications] Notification sent successfully', {
            highlight_id: highlight.id,
            channels: results.filter((r) => r.success).map((r) => r.channel),
          });
        } else {
          errorCount++;
          safeLog.warn('[ReflectionNotifications] All channels failed for highlight', {
            highlight_id: highlight.id,
            errors: results.map((r) => ({ channel: r.channel, error: r.error })),
          });
        }
      } catch (error) {
        errorCount++;
        safeLog.error('[ReflectionNotifications] Unexpected error sending notification', {
          highlight_id: highlight.id,
          error: String(error),
        });
      }
    }

    safeLog.info('[ReflectionNotifications] Notification batch completed', {
      total: highlights.length,
      success: successCount,
      errors: errorCount,
    });
  });
}
