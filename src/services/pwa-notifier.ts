/**
 * PWA Notifier Service (Phase 5.3)
 *
 * Purpose: Send real-time notifications to Cockpit PWA via WebSocket
 * Architecture: D1 cockpit_alerts + COCKPIT_WS Durable Object broadcast
 */

import { Env } from '../types';
import { safeLog } from '../utils/log-sanitizer';

/**
 * Alert severity levels
 */
export type AlertSeverity = 'critical' | 'warning' | 'info';

/**
 * Alert payload for PWA notification
 */
export interface PWAAlert {
  id: string;
  severity: AlertSeverity;
  title: string;
  message: string;
  source: string;
  actionUrl?: string; // Optional: URL for user action
}

/**
 * Send alert to PWA via WebSocket (Primary notification channel)
 *
 * Flow:
 * 1. Save alert to D1 cockpit_alerts table
 * 2. Broadcast to all connected PWA clients via COCKPIT_WS
 * 3. Return success/failure status
 */
export async function sendPWAAlert(
  env: Env,
  alert: PWAAlert
): Promise<{ success: boolean; error?: string }> {
  try {
    // Step 1: Save alert to D1 for persistence
    if (!env.DB) {
      safeLog.warn('[PWA Notifier] D1 database not configured, skipping alert storage');
    } else {
      const createdAt = Math.floor(Date.now() / 1000); // Unix timestamp

      await env.DB.prepare(`
        INSERT INTO cockpit_alerts (id, severity, title, message, source, created_at, acknowledged)
        VALUES (?, ?, ?, ?, ?, ?, 0)
      `)
        .bind(alert.id, alert.severity, alert.title, alert.message, alert.source, createdAt)
        .run();

      safeLog.info('[PWA Notifier] Alert saved to D1', {
        id: alert.id,
        severity: alert.severity,
      });
    }

    // Step 2: Broadcast to PWA clients via WebSocket
    if (!env.COCKPIT_WS) {
      safeLog.warn('[PWA Notifier] COCKPIT_WS not configured, skipping WebSocket broadcast');
      return { success: false, error: 'COCKPIT_WS not configured' };
    }

    // Get Durable Object stub
    const id = env.COCKPIT_WS.idFromName('default');
    const stub = env.COCKPIT_WS.get(id);

    // Call /broadcast-alert endpoint
    const response = await stub.fetch('https://internal/broadcast-alert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: alert.id,
        severity: alert.severity,
        title: alert.title,
        message: alert.message,
        source: alert.source,
        createdAt: Math.floor(Date.now() / 1000),
        acknowledged: false,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      safeLog.error('[PWA Notifier] WebSocket broadcast failed', {
        status: response.status,
        error: errorText,
      });
      return { success: false, error: `Broadcast failed: ${response.status}` };
    }

    const result = await response.json() as { success: boolean; sentCount: number };

    safeLog.info('[PWA Notifier] Alert broadcasted to PWA', {
      id: alert.id,
      severity: alert.severity,
      sentCount: result.sentCount,
    });

    return { success: true };
  } catch (error) {
    safeLog.error('[PWA Notifier] Failed to send PWA alert', {
      error: String(error),
    });
    return { success: false, error: String(error) };
  }
}

/**
 * Helper: Generate unique alert ID
 */
export function generateAlertId(prefix: string): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  return `${prefix}-${timestamp}-${random}`;
}
