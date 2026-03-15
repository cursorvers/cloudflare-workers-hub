/**
 * Gmail Receipt Poller — Main Orchestrator
 *
 * Coordinates PDF and HTML receipt processing pipelines:
 * - Pre-flight checks (DB, KV, Gmail, freee)
 * - Distributed locking
 * - Delegates to receipt-pdf-processor / receipt-html-processor
 * - Aggregates metrics and alerting
 */

import type { Env } from '../types';
import { safeLog } from '../utils/log-sanitizer';
import {
  fetchHtmlReceiptEmails,
  type GmailReceiptEmail,
  type GmailHtmlReceiptEmail,
  type ShouldDownloadAttachment,
} from '../services/gmail-receipt-client';
import { createFreeeClient } from '../services/freee-client';
import { isFreeeIntegrationEnabled } from '../utils/freee-integration';
import { withLock } from './scheduled';
import { HEALTH } from '../config/confidence-thresholds';

import { getReceiptBucket, MAX_RESULTS, resolveOperationalTenantId } from './receipt-poller-utils';
import {
  processAttachment,
  fetchReceiptEmailsWithRetry,
  processedAttachmentKey,
  type PdfTextMetrics,
} from './receipt-pdf-processor';
import { processHtmlReceipt, htmlProcessedKey } from './receipt-html-processor';

// Re-export for backward compatibility (tests import from this module)
export { buildClassificationText } from './receipt-pdf-processor';

const LOCK_TTL_SECONDS = 300;

async function hasFreeeAuthTokens(env: Env, tenantId: string): Promise<boolean> {
  // Prefer D1 (current). Fallback to KV (legacy) if present.
  if (env.DB) {
    try {
      const row = await env.DB.prepare(
        `SELECT encrypted_refresh_token
         FROM external_oauth_tokens
         WHERE tenant_id = ? AND provider = 'freee'
         LIMIT 1`
      ).bind(tenantId).first() as { encrypted_refresh_token?: string | null } | null;
      if (row?.encrypted_refresh_token) return true;
    } catch {
      // ignore
    }
  }

  if (env.KV) {
    try {
      // kv-optimizer:ignore-next
      const token = await env.KV.get(`freee:${tenantId}:refresh_token`);
      return Boolean(token);
    } catch {
      return false;
    }
  }

  return false;
}

export async function handleGmailReceiptPolling(env: Env, tenantId?: string): Promise<void> {
  if (!env.DB) {
    safeLog.warn('[Gmail Poller] DB not configured, skipping');
    return;
  }
  if (!env.KV) {
    safeLog.warn('[Gmail Poller] KV not configured, skipping');
    return;
  }

  const bucket = getReceiptBucket(env);
  if (!bucket) {
    safeLog.warn('[Gmail Poller] Receipt bucket not configured, skipping');
    return;
  }

  if (!env.GMAIL_CLIENT_ID || !env.GMAIL_CLIENT_SECRET || !env.GMAIL_REFRESH_TOKEN) {
    safeLog.warn('[Gmail Poller] Gmail credentials not configured, skipping');
    return;
  }

  if (!isFreeeIntegrationEnabled(env)) {
    safeLog.warn('[Gmail Poller] freee integration disabled, skipping');
    return;
  }

  if (!env.FREEE_CLIENT_ID || !env.FREEE_CLIENT_SECRET || !env.FREEE_ENCRYPTION_KEY) {
    safeLog.warn('[Gmail Poller] freee integration not configured (missing secrets), skipping');
    return;
  }

  const operationalTenantId = tenantId ?? await resolveOperationalTenantId(env);

  if (!(await hasFreeeAuthTokens(env, operationalTenantId))) {
    safeLog.warn('[Gmail Poller] freee not authenticated (no tokens found), skipping');
    return;
  }

  await withLock(env.KV, `gmail:polling:${operationalTenantId}`, LOCK_TTL_SECONDS, async () => {
    const startTime = Date.now();
    safeLog.info('[Gmail Poller] Starting Gmail receipt polling');

    let emails: GmailReceiptEmail[] = [];
    const buildShouldDownload = (): { shouldDownloadAttachment: ShouldDownloadAttachment; } => {
      let cacheReadFailed = false;
      return {
        shouldDownloadAttachment: async ({ messageId, attachmentId }) => {
          if (!env.CACHE) return true;
          try {
            const existing = await env.CACHE.get(processedAttachmentKey(messageId, attachmentId));
            return !existing;
          } catch (error) {
            if (!cacheReadFailed) {
              cacheReadFailed = true;
              safeLog.warn('[Gmail Poller] CACHE read failed (will download anyway)', {
                error: error instanceof Error ? error.message : String(error),
              });
            }
            return true;
          }
        },
      };
    };

    try {
      emails = await fetchReceiptEmailsWithRetry(env, {
        maxResults: MAX_RESULTS,
        newerThan: '24h',
        ...buildShouldDownload(),
      });
    } catch (error) {
      safeLog.warn('[Gmail Poller] Initial fetch failed, retrying with 24h window', {
        error: error instanceof Error ? error.message : String(error),
      });
      // Catch-up: widen the search window to recover missed emails after outage.
      try {
        emails = await fetchReceiptEmailsWithRetry(env, {
          maxResults: MAX_RESULTS,
          newerThan: '24h',
          ...buildShouldDownload(),
        });
      } catch (retryError) {
        safeLog.error('[Gmail Poller] Failed to fetch Gmail receipts (catch-up also failed)', {
          error: retryError instanceof Error ? retryError.message : String(retryError),
        });
        return;
      }
    }

    const freeeClient = createFreeeClient(env, { tenantId: operationalTenantId });
    const metrics = { processed: 0, skipped: 0, failed: 0, dealsCreated: 0 };
    const pdfTextMetrics: PdfTextMetrics = {
      attempted: 0,
      extracted: 0,
      failed: 0,
      skipped: 0,
      notAttempted: 0,
      reasons: {} as Record<string, number>,
      totalElapsedMs: 0,
    };

    if (emails.length === 0) {
      safeLog.info('[Gmail Poller] No PDF receipt emails found');
    } else {
      for (const email of emails) {
        for (const attachment of email.attachments) {
          await processAttachment(env, operationalTenantId, bucket, freeeClient, email, attachment, metrics, pdfTextMetrics);
        }
      }
    }

    // Phase 2: HTML receipt polling (feature-flagged, subject-keyword matching)
    let htmlMetrics = { processed: 0, skipped: 0, failed: 0 };
    if (env.GMAIL_HTML_RECEIPTS_ENABLED === 'true') {
      // Optional sender allowlist (additive, not restrictive)
      const senderAllowlist = (env.GMAIL_HTML_RECEIPT_SENDERS || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);

      let htmlEmails: GmailHtmlReceiptEmail[] = [];
      try {
        htmlEmails = await fetchHtmlReceiptEmails(
          {
            clientId: env.GMAIL_CLIENT_ID!,
            clientSecret: env.GMAIL_CLIENT_SECRET!,
            refreshToken: env.GMAIL_REFRESH_TOKEN!,
          },
          {
            senderAllowlist: senderAllowlist.length > 0 ? senderAllowlist : undefined,
            maxResults: 10,
            newerThan: '24h',
          }
        );
        safeLog.info('[Gmail Poller] HTML emails found', {
          count: htmlEmails.length,
          subjects: htmlEmails.map(e => e.subject).slice(0, 5),
        });
      } catch (error) {
        safeLog.error('[Gmail Poller] HTML receipt fetch failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }

      // Filter already-processed HTML emails
      const unprocessed: GmailHtmlReceiptEmail[] = [];
      for (const htmlEmail of htmlEmails) {
        if (env.CACHE) {
          try {
            const existing = await env.CACHE.get(htmlProcessedKey(htmlEmail.messageId));
            if (existing) {
              htmlMetrics.skipped += 1;
              continue;
            }
          } catch {
            // fail-open
          }
        }
        unprocessed.push(htmlEmail);
      }

      const htmlDealMetrics = { ...metrics }; // Share deal counter with PDF path
      for (const htmlEmail of unprocessed) {
        await processHtmlReceipt(env, operationalTenantId, bucket, freeeClient, htmlEmail, htmlDealMetrics);
      }
      htmlMetrics = {
        processed: htmlDealMetrics.processed - metrics.processed,
        skipped: htmlMetrics.skipped + (htmlDealMetrics.skipped - metrics.skipped),
        failed: htmlDealMetrics.failed - metrics.failed,
      };
    }

    const pdfExtractionEnabled = env.PDF_TEXT_EXTRACTION_ENABLED === 'true';

    safeLog.info('[Gmail Poller] Polling completed', {
      processed: metrics.processed,
      skipped: metrics.skipped,
      failed: metrics.failed,
      dealsCreated: metrics.dealsCreated,
      ...(pdfExtractionEnabled
        ? {
            pdfTextAttempted: pdfTextMetrics.attempted,
            pdfTextExtracted: pdfTextMetrics.extracted,
            pdfTextFailed: pdfTextMetrics.failed,
            pdfTextSkipped: pdfTextMetrics.skipped,
            pdfTextNotAttempted: pdfTextMetrics.notAttempted,
            pdfTextTotalElapsedMs: pdfTextMetrics.totalElapsedMs,
            pdfTextReasons: pdfTextMetrics.reasons,
          }
        : {}),
      ...(env.GMAIL_HTML_RECEIPTS_ENABLED === 'true'
        ? {
            htmlProcessed: htmlMetrics.processed,
            htmlSkipped: htmlMetrics.skipped,
            htmlFailed: htmlMetrics.failed,
          }
        : {}),
      durationMs: Date.now() - startTime,
    });

    // Health tracking: record last successful poll timestamp
    if (env.KV) {
      try {
        await env.KV.put(HEALTH.LAST_POLL_KEY, new Date().toISOString(), {
          expirationTtl: 60 * 60 * 24 * 7, // 7 days
        });
      } catch {
        // best-effort
      }
    }

    // Alerting: notify on failures via Discord webhook (metadata only, no PII)
    if (metrics.failed > 0 && env.DISCORD_WEBHOOK_URL) {
      try {
        await fetch(env.DISCORD_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: `⚠️ **Receipt Pipeline Alert**\n` +
              `Failed: ${metrics.failed} | Processed: ${metrics.processed} | Deals: ${metrics.dealsCreated}\n` +
              `Duration: ${Date.now() - startTime}ms\n` +
              `Check logs for details.`,
          }),
        });
      } catch {
        // alerting is best-effort
      }
    }
  });
}
