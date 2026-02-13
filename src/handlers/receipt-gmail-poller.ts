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
import { createDealFromReceipt, type ReceiptInput } from '../services/freee-deal-service';
import { isFreeeIntegrationEnabled } from '../utils/freee-integration';
import { withLock } from './scheduled';
import { HEALTH, CONFIDENCE } from '../config/confidence-thresholds';

import { getReceiptBucket, MAX_RESULTS } from './receipt-poller-utils';
import {
  processAttachment,
  fetchReceiptEmailsWithRetry,
  processedAttachmentKey,
  type PdfTextMetrics,
} from './receipt-pdf-processor';
import { processHtmlReceipt, htmlProcessedKey, retryFailedHtmlReceipts } from './receipt-html-processor';

// Re-export for backward compatibility (tests import from this module)
export { buildClassificationText } from './receipt-pdf-processor';

const LOCK_KEY = 'gmail:polling';
const LOCK_TTL_SECONDS = 300;

async function hasFreeeAuthTokens(env: Env): Promise<boolean> {
  // Prefer D1 (current). Fallback to KV (legacy) if present.
  if (env.DB) {
    try {
      const row = await env.DB.prepare(
        `SELECT encrypted_refresh_token
         FROM external_oauth_tokens
         WHERE provider = 'freee'
         LIMIT 1`
      ).first() as { encrypted_refresh_token?: string | null } | null;
      if (row?.encrypted_refresh_token) return true;
    } catch {
      // ignore
    }
  }

  if (env.KV) {
    try {
      // kv-optimizer:ignore-next
      const token = await env.KV.get('freee:refresh_token');
      return Boolean(token);
    } catch {
      return false;
    }
  }

  return false;
}

export async function handleGmailReceiptPolling(env: Env): Promise<void> {
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

  if (!(await hasFreeeAuthTokens(env))) {
    safeLog.warn('[Gmail Poller] freee not authenticated (no tokens found), skipping');
    return;
  }

  await withLock(env.KV, LOCK_KEY, LOCK_TTL_SECONDS, async () => {
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

    const freeeClient = createFreeeClient(env);
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
          await processAttachment(env, bucket, freeeClient, email, attachment, metrics, pdfTextMetrics);
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
        await processHtmlReceipt(env, bucket, freeeClient, htmlEmail, htmlDealMetrics);
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

    // Retry previously failed HTML receipts (e.g. blocked by external-reference guard)
    if (isFreeeIntegrationEnabled(env) && env.GMAIL_HTML_RECEIPTS_ENABLED === 'true') {
      try {
        const retryResult = await retryFailedHtmlReceipts(env, bucket, freeeClient, 5);
        if (retryResult.retried > 0) {
          safeLog.info('[Gmail Poller] Retried failed HTML receipts', retryResult);
        }
      } catch (retryError) {
        safeLog.warn('[Gmail Poller] Retry of failed receipts encountered an error', {
          error: retryError instanceof Error ? retryError.message : String(retryError),
        });
      }
    }

    // Retry deal creation for completed receipts missing deals (e.g. after OAuth scope fix)
    if (isFreeeIntegrationEnabled(env)) {
      try {
        const pendingDeals = await env.DB!.prepare(
          `SELECT id, vendor_name, amount, transaction_date, account_category,
                  classification_confidence, freee_receipt_id, file_hash, tenant_id
           FROM receipts
           WHERE status = 'completed'
             AND freee_receipt_id IS NOT NULL
             AND freee_deal_id IS NULL
             AND document_type != 'other'
           ORDER BY created_at ASC
           LIMIT 8`
        ).all<{
          id: string; vendor_name: string; amount: number; transaction_date: string;
          account_category: string | null; classification_confidence: number | null;
          freee_receipt_id: string; file_hash: string; tenant_id: string;
        }>();

        if (pendingDeals.results && pendingDeals.results.length > 0) {
          let dealsCreated = 0;
          for (const r of pendingDeals.results) {
            try {
              const receiptInput: ReceiptInput = {
                id: r.id,
                freee_receipt_id: r.freee_receipt_id,
                retry_link_if_existing: true,
                file_hash: r.file_hash,
                vendor_name: r.vendor_name,
                amount: r.amount,
                transaction_date: r.transaction_date,
                account_category: r.account_category,
                classification_confidence: r.classification_confidence,
                tenant_id: r.tenant_id || 'default',
              };
              const dealResult = await createDealFromReceipt(env, receiptInput);
              if (dealResult.dealId) {
                await env.DB!.prepare(
                  `UPDATE receipts SET freee_deal_id = ?, freee_partner_id = ?,
                     account_item_id = ?, tax_code = ?,
                     account_mapping_confidence = ?, account_mapping_method = ?,
                     updated_at = datetime('now')
                   WHERE id = ?`
                ).bind(
                  dealResult.dealId, dealResult.partnerId,
                  dealResult.accountItemId ?? null, dealResult.taxCode ?? null,
                  dealResult.mappingConfidence, dealResult.mappingMethod ?? null,
                  r.id
                ).run();
                dealsCreated += 1;
              }
            } catch (dealError) {
              safeLog.warn('[Gmail Poller] Deal retry failed for completed receipt', {
                receiptId: r.id,
                error: dealError instanceof Error ? dealError.message : String(dealError),
              });
            }
          }
          if (dealsCreated > 0 || pendingDeals.results.length > 0) {
            safeLog.info('[Gmail Poller] Deal retry for completed receipts', {
              attempted: pendingDeals.results.length,
              created: dealsCreated,
            });
          }
        }
      } catch (dealRetryError) {
        safeLog.warn('[Gmail Poller] Deal retry batch error', {
          error: dealRetryError instanceof Error ? dealRetryError.message : String(dealRetryError),
        });
      }
    }

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

    // ── Periodic audit: detect non-receipt leaks & data quality issues ──
    const auditAlerts: string[] = [];
    try {
      const auditResults = await env.DB!.batch([
        // Non-receipt docs uploaded to freee (should not happen after guard)
        env.DB!.prepare(
          `SELECT COUNT(*) as cnt FROM receipts
           WHERE document_type = 'other' AND freee_receipt_id IS NOT NULL`
        ),
        // Email-like vendor names in completed receipts
        env.DB!.prepare(
          `SELECT COUNT(*) as cnt FROM receipts
           WHERE status = 'completed' AND vendor_name LIKE '%@%'`
        ),
        // Suspiciously high amounts (> ¥500,000) — likely misextraction
        env.DB!.prepare(
          `SELECT COUNT(*) as cnt FROM receipts
           WHERE amount > 500000 AND status = 'completed'`
        ),
        // Stale failed receipts (retry_count maxed out)
        env.DB!.prepare(
          `SELECT COUNT(*) as cnt FROM receipts
           WHERE status = 'failed' AND retry_count >= 3`
        ),
        // Completed receipts without deals (deal retry backlog)
        env.DB!.prepare(
          `SELECT COUNT(*) as cnt FROM receipts
           WHERE status = 'completed' AND freee_receipt_id IS NOT NULL
             AND freee_deal_id IS NULL AND document_type <> 'other'`
        ),
        // Deal row exists but receipt row still has no freee_deal_id (likely link failure / sync gap)
        env.DB!.prepare(
          `SELECT COUNT(*) as cnt
           FROM receipt_deals rd
           INNER JOIN receipts r ON r.id = rd.receipt_id
           WHERE r.status = 'completed'
             AND r.freee_receipt_id IS NOT NULL
             AND r.freee_deal_id IS NULL
             AND r.document_type <> 'other'`
        ),
        // Needs-review count (detect if guard is too strict)
        env.DB!.prepare(
          `SELECT COUNT(*) as cnt FROM receipts WHERE status = 'needs_review'`
        ),
      ]);

      const nonReceiptLeaks = (auditResults[0].results?.[0] as { cnt: number } | undefined)?.cnt ?? 0;
      const emailVendors = (auditResults[1].results?.[0] as { cnt: number } | undefined)?.cnt ?? 0;
      const suspiciousAmounts = (auditResults[2].results?.[0] as { cnt: number } | undefined)?.cnt ?? 0;
      const staleFailed = (auditResults[3].results?.[0] as { cnt: number } | undefined)?.cnt ?? 0;
      const dealBacklog = (auditResults[4].results?.[0] as { cnt: number } | undefined)?.cnt ?? 0;
      const dealLinkGaps = (auditResults[5].results?.[0] as { cnt: number } | undefined)?.cnt ?? 0;
      const needsReviewCount = (auditResults[6].results?.[0] as { cnt: number } | undefined)?.cnt ?? 0;

      if (nonReceiptLeaks > 0) {
        auditAlerts.push(`Non-receipt docs in freee: ${nonReceiptLeaks}`);
      }
      if (emailVendors > 0) {
        auditAlerts.push(`Email-like vendor names: ${emailVendors}`);
      }
      if (suspiciousAmounts > 0) {
        auditAlerts.push(`Suspicious amounts (>¥500k): ${suspiciousAmounts}`);
      }
      if (staleFailed > 0) {
        auditAlerts.push(`Stale failed (max retries): ${staleFailed}`);
      }
      if (dealLinkGaps > 0) {
        auditAlerts.push(`Deal created but receipt row unlinked: ${dealLinkGaps}`);
      }

      if (needsReviewCount > 20) {
        auditAlerts.push(`Needs-review backlog high: ${needsReviewCount}`);
      }

      safeLog.info('[Gmail Poller] Audit check completed', {
        nonReceiptLeaks,
        emailVendors,
        suspiciousAmounts,
        staleFailed,
        dealBacklog,
        dealLinkGaps,
        needsReviewCount,
        alertCount: auditAlerts.length,
      });
    } catch (auditError) {
      safeLog.warn('[Gmail Poller] Audit check failed', {
        error: auditError instanceof Error ? auditError.message : String(auditError),
      });
    }

    // Alerting: notify on failures or audit issues via Discord webhook (metadata only, no PII)
    const alertParts: string[] = [];
    if (metrics.failed > 0) {
      alertParts.push(
        `Failed: ${metrics.failed} | Processed: ${metrics.processed} | Deals: ${metrics.dealsCreated}`
      );
    }
    if (auditAlerts.length > 0) {
      alertParts.push(`Audit: ${auditAlerts.join(', ')}`);
    }

    if (alertParts.length > 0 && env.DISCORD_WEBHOOK_URL) {
      try {
        await fetch(env.DISCORD_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: `⚠️ **Receipt Pipeline Alert**\n` +
              alertParts.join('\n') + '\n' +
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
