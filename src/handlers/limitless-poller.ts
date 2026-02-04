/**
 * Limitless Cron Poller (Phase 5.2 → Phase 5.3)
 *
 * Purpose: Automatically poll Limitless.ai API for new transcripts
 * and create reflections without manual intervention.
 *
 * Features:
 * - Hourly polling of /lifelogs API
 * - New transcript detection (not in Supabase)
 * - Automatic reflection creation with PHI detection
 * - Dry-run mode for testing
 * - PWA WebSocket notifications (Phase 5.3 - Primary)
 * - Discord failure notifications (Phase 5.3 - Backup)
 * - Rate limit handling with exponential backoff
 */

import { Env } from '../types';
import { safeLog } from '../utils/log-sanitizer';
import { getRecentLifelogs, type Lifelog } from '../services/limitless';
import { supabaseSelect, supabaseInsert, type SupabaseConfig } from '../services/supabase-client';
import { detectPHI } from '../services/phi-detector';
import { sendReflectionNotification } from '../services/reflection-notifier';
import { sendPWAAlert, generateAlertId } from '../services/pwa-notifier';

/**
 * Cron handler: Poll Limitless.ai API and create reflections
 */
export async function handleLimitlessPollerCron(env: Env): Promise<void> {
  const isDryRun = env.DRY_RUN === 'true';

  safeLog.info('[Limitless Poller] Starting cron execution', {
    isDryRun,
    timestamp: new Date().toISOString(),
  });

  try {
    // Step 1: Fetch recent lifelogs from Limitless.ai (last 2 hours to account for delays)
    const apiKey = env.LIMITLESS_API_KEY;
    if (!apiKey) {
      throw new Error('LIMITLESS_API_KEY not configured');
    }

    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const { lifelogs } = await getRecentLifelogs(apiKey, {
      limit: 10,
      startTime: twoHoursAgo,
    });

    safeLog.info('[Limitless Poller] Fetched lifelogs', {
      count: lifelogs.length,
    });

    if (lifelogs.length === 0) {
      safeLog.info('[Limitless Poller] No new lifelogs found');
      return;
    }

    // Step 2: Filter new transcripts (not in Supabase)
    const config: SupabaseConfig = {
      url: env.SUPABASE_URL!,
      serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY!,
    };

    const newLifelogs = await filterNewLifelogs(config, lifelogs);

    safeLog.info('[Limitless Poller] Filtered new lifelogs', {
      total: lifelogs.length,
      new: newLifelogs.length,
    });

    if (newLifelogs.length === 0) {
      safeLog.info('[Limitless Poller] No new transcripts to process');
      return;
    }

    // Step 3: Create reflections for each new lifelog
    let successCount = 0;
    let skipCount = 0;
    let errorCount = 0;

    for (const lifelog of newLifelogs) {
      try {
        const result = await createReflectionFromLifelog(env, config, lifelog, isDryRun);
        if (result.success) {
          successCount++;
        } else {
          skipCount++;
        }
      } catch (error) {
        errorCount++;
        safeLog.error('[Limitless Poller] Failed to create reflection', {
          lifelog_id: lifelog.id,
          error: String(error),
        });

        // Send Discord alert on error
        await sendDiscordAlert(env, `❌ 振り返り作成失敗: ${lifelog.title || lifelog.id}`).catch(
          (err) => {
            safeLog.error('[Limitless Poller] Failed to send Discord alert', {
              error: String(err),
            });
          }
        );
      }
    }

    safeLog.info('[Limitless Poller] Cron execution completed', {
      total: newLifelogs.length,
      success: successCount,
      skipped: skipCount,
      errors: errorCount,
      isDryRun,
    });

    // Send Discord summary (only on production mode)
    if (!isDryRun && (successCount > 0 || errorCount > 0)) {
      await sendDiscordAlert(
        env,
        `✅ Limitless Poller 完了\n成功: ${successCount}, スキップ: ${skipCount}, エラー: ${errorCount}`
      ).catch((err) => {
        safeLog.error('[Limitless Poller] Failed to send summary alert', {
          error: String(err),
        });
      });
    }
  } catch (error) {
    safeLog.error('[Limitless Poller] Cron execution failed', {
      error: String(error),
    });

    // Send Discord alert on critical error
    await sendDiscordAlert(env, `🚨 Limitless Poller 障害: ${String(error)}`).catch((err) => {
      safeLog.error('[Limitless Poller] Failed to send critical alert', {
        error: String(err),
      });
    });

    throw error;
  }
}

/**
 * Filter lifelogs that are not yet in Supabase
 * Uses lifelog_highlights table (lifelog_id field) to track processed lifelogs
 */
async function filterNewLifelogs(
  config: SupabaseConfig,
  lifelogs: Lifelog[]
): Promise<Lifelog[]> {
  if (lifelogs.length === 0) {
    return [];
  }

  try {
    // Query existing lifelog IDs from lifelog_highlights
    // SECURITY: Encode IDs to prevent query manipulation
    const encodedIds = lifelogs.map((l) => encodeURIComponent(l.id)).join(',');
    const query = `select=lifelog_id&lifelog_id=in.(${encodedIds})`;

    const { data: existingHighlights } = await supabaseSelect<{ lifelog_id: string }>(
      config,
      'lifelog_highlights',
      query
    );

    const existingIds = new Set((existingHighlights || []).map((h) => h.lifelog_id));

    // Filter out existing lifelogs
    const newLifelogs = lifelogs.filter((l) => !existingIds.has(l.id));

    return newLifelogs;
  } catch (error) {
    safeLog.error('[Limitless Poller] Failed to filter new lifelogs', {
      error: String(error),
    });
    // On error, treat all lifelogs as new (fail open)
    return lifelogs;
  }
}

/**
 * Create reflection from a single lifelog
 */
async function createReflectionFromLifelog(
  env: Env,
  config: SupabaseConfig,
  lifelog: Lifelog,
  isDryRun: boolean
): Promise<{ success: boolean; reason?: string }> {
  const transcript = lifelog.markdown || lifelog.contents?.map((c) => c.content).join('\n') || '';

  if (!transcript || transcript.trim().length === 0) {
    safeLog.warn('[Limitless Poller] Skipping lifelog with empty transcript', {
      lifelog_id: lifelog.id,
    });
    return { success: false, reason: 'Empty transcript' };
  }

  // PHI detection
  const phiResult = detectPHI(transcript);

  safeLog.info('[Limitless Poller] Processing lifelog', {
    lifelog_id: lifelog.id,
    title: lifelog.title,
    transcript_length: transcript.length,
    contains_phi: phiResult.contains_phi,
    needs_verification: phiResult.needs_verification,
  });

  if (isDryRun) {
    safeLog.info('[Limitless Poller] DRY-RUN: Would create reflection', {
      lifelog_id: lifelog.id,
      title: lifelog.title,
      contains_phi: phiResult.contains_phi,
      needs_verification: phiResult.needs_verification,
    });
    return { success: true };
  }

  let highlightId: string | undefined;

  try {
    // Step 1: Create highlight (tracks lifelog_id)
    const highlightResult = await supabaseInsert<{ id: string }>(
      config,
      'lifelog_highlights',
      {
        lifelog_id: lifelog.id,
        highlight_time: lifelog.startTime,
        extracted_text: transcript.substring(0, 500), // First 500 chars
        speaker_name: 'Auto-detected',
        topics: [], // TODO: Extract topics using Workers AI
        status: 'pending_review',
        created_at: new Date().toISOString(),
      }
    );

    highlightId = highlightResult.data?.[0]?.id;
    if (!highlightId) {
      throw new Error('Failed to create highlight');
    }

    // Step 2: Create reflection (CRITICAL: force private if contains PHI)
    // Always force private when contains_phi=true, regardless of needs_verification
    const is_public = phiResult.contains_phi ? false : true;

    await supabaseInsert(config, 'user_reflections', {
      highlight_id: highlightId,
      user_id: 'default_user',
      reflection_text: `[自動生成] ${lifelog.title || 'Untitled'}\n\n${transcript.substring(0, 200)}...`,
      key_insights: [],
      action_items: [],
      contains_phi: phiResult.contains_phi,
      phi_approved: false,
      is_public,
      created_at: new Date().toISOString(),
    });

    safeLog.info('[Limitless Poller] Reflection created successfully', {
      lifelog_id: lifelog.id,
      highlight_id: highlightId,
      contains_phi: phiResult.contains_phi,
      needs_verification: phiResult.needs_verification,
    });

    // Send notifications if needs verification
    // CRITICAL: Do NOT include transcript in notification to prevent PHI leakage
    // Phase 5.3: PWA WebSocket (Primary) + Discord (Backup)
    if (phiResult.needs_verification) {
      const reviewUrl = `https://cockpit.masayuki.work/reflections/${highlightId}`;

      // PRIMARY: Send PWA WebSocket notification
      const pwaResult = await sendPWAAlert(env, {
        id: generateAlertId('phi-review'),
        severity: 'warning',
        title: 'PHI検出: 手動レビュー必要',
        message: `自動生成トランスクリプトに個人健康情報が検出されました。レビューして承認してください。`,
        source: 'limitless-poller',
        actionUrl: reviewUrl,
      });

      if (pwaResult.success) {
        safeLog.info('[Limitless Poller] PWA notification sent successfully', {
          highlight_id: highlightId,
        });
      } else {
        safeLog.warn('[Limitless Poller] PWA notification failed, falling back to Discord', {
          highlight_id: highlightId,
          error: pwaResult.error,
        });
      }

      // BACKUP: Send Discord notification (always execute for redundancy)
      await sendReflectionNotification(
        env,
        'discord',
        {
          highlight_id: highlightId,
          highlight_time: lifelog.startTime,
          extracted_text: `⚠️ PHI検出: 自動生成トランスクリプトの手動レビューが必要です`,
          speaker_name: 'Auto-detected',
          topics: ['PHI Review Required', 'Auto-generated'],
          notification_url: reviewUrl,
        },
        true // force=true
      ).catch((error) => {
        safeLog.error('[Limitless Poller] Discord notification failed', {
          highlight_id: highlightId,
          error: String(error),
        });
      });
    }

    return { success: true };
  } catch (error) {
    safeLog.error('[Limitless Poller] Failed to create reflection', {
      lifelog_id: lifelog.id,
      highlight_id: highlightId,
      error: String(error),
    });

    // CRITICAL: If reflection creation fails after highlight creation,
    // the highlight remains orphaned and won't be retried.
    // TODO: Implement cleanup or status update to enable retry
    if (highlightId) {
      safeLog.warn('[Limitless Poller] Orphaned highlight detected', {
        highlight_id: highlightId,
        lifelog_id: lifelog.id,
        note: 'Manual cleanup required or implement status-based retry',
      });
    }

    throw error;
  }
}

/**
 * Send Discord alert to #alerts channel
 */
async function sendDiscordAlert(env: Env, message: string): Promise<void> {
  const webhookUrl = env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) {
    safeLog.warn('[Limitless Poller] Discord webhook URL not configured');
    return;
  }

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        content: `🤖 **Limitless Poller**\n${message}`,
      }),
    });

    if (!response.ok) {
      throw new Error(`Discord API error: ${response.status}`);
    }

    safeLog.info('[Limitless Poller] Discord alert sent', {
      message: message.substring(0, 50),
    });
  } catch (error) {
    safeLog.error('[Limitless Poller] Failed to send Discord alert', {
      error: String(error),
    });
    throw error;
  }
}
