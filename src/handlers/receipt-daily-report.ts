import type { Env } from '../types';
import { safeLog } from '../utils/log-sanitizer';
import { sendTextEmailViaGmailOAuth } from '../services/gmail-sender';
import { resolveGmailRefreshToken } from '../services/gmail-oauth-token-store';
import { createFreeeClient, type FreeeWalletTxn } from '../services/freee-client';
import { isFreeeIntegrationEnabled } from '../utils/freee-integration';

type ReceiptRow = {
  id: string;
  vendor_name: string;
  amount: number;
  currency: string;
  transaction_date: string;
  status: string;
  freee_receipt_id: string | null;
  freee_deal_id: number | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
};

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDaysIso(iso: string, deltaDays: number): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return toIsoDate(d);
}

function normalizeText(s: string): string {
  return String(s || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9 \-_.@]/g, '')
    .trim();
}

function scoreWalletCandidate(args: {
  receiptVendor: string;
  receiptDate: string;
  receiptCurrency: string;
  receiptAmount: number;
  txn: FreeeWalletTxn;
}): { score: number; reasons: string[]; impliedFx?: number } {
  const reasons: string[] = [];

  const receiptDate = new Date(`${args.receiptDate}T00:00:00.000Z`).getTime();
  const txnDate = new Date(`${args.txn.date}T00:00:00.000Z`).getTime();
  const dayDiff = Math.abs(Math.round((txnDate - receiptDate) / (1000 * 60 * 60 * 24)));

  let score = 0;
  score += Math.max(0, 30 - dayDiff * 10);
  if (dayDiff === 0) reasons.push('date:0d');
  else reasons.push(`date:${dayDiff}d`);

  const vendor = normalizeText(args.receiptVendor);
  const desc = normalizeText(args.txn.description || '');
  if (vendor && desc) {
    const tokens = vendor.split(/\s+/).filter(t => t.length >= 3).slice(0, 5);
    const hits = tokens.filter(t => desc.includes(t)).length;
    if (hits > 0) {
      score += Math.min(30, hits * 10);
      reasons.push(`vendor_hit:${hits}`);
    }
  }

  // FX sanity (USD only for now)
  const absJpy = Math.abs(Number(args.txn.amount_jpy || 0));
  if (args.receiptCurrency.toUpperCase() === 'USD' && args.receiptAmount > 0 && absJpy > 0) {
    const implied = absJpy / args.receiptAmount;
    // Very broad guardrail to avoid nonsense (e.g. 25 USD => 2500 JPY)
    if (implied >= 50 && implied <= 250) {
      score += 20;
      reasons.push(`fx_ok:${implied.toFixed(1)}`);
    } else {
      score -= 10;
      reasons.push(`fx_out:${implied.toFixed(1)}`);
    }
    return { score, reasons, impliedFx: implied };
  }

  return { score, reasons };
}

function formatReceiptLine(r: ReceiptRow): string {
  const cur = (r.currency || 'JPY').toUpperCase();
  const amountStr = Number.isFinite(r.amount) ? String(r.amount) : String(r.amount ?? '');
  const receiptId = r.freee_receipt_id ? String(r.freee_receipt_id) : '-';
  const dealId = r.freee_deal_id ? String(r.freee_deal_id) : '-';
  const status = r.status || '-';
  const vendor = (r.vendor_name || '').slice(0, 60);
  return `${r.transaction_date} | ${vendor} | ${cur} ${amountStr} | status=${status} | receipt=${receiptId} | deal=${dealId}`;
}

export async function sendReceiptDailyReport(env: Env, options?: {
  days?: number;
  limit?: number;
}): Promise<{ sent: boolean; foreign: number; needsReview: number }>{
  const enabled = (env.RECEIPT_DAILY_REPORT_ENABLED || '').trim().toLowerCase() === 'true';
  if (!enabled) return { sent: false, foreign: 0, needsReview: 0 };

  if (!env.DB) {
    safeLog.warn('[ReceiptDailyReport] DB not configured, skipping');
    return { sent: false, foreign: 0, needsReview: 0 };
  }

  const to = (env.RECEIPT_DAILY_REPORT_EMAIL_TO || '').trim();
  if (!to) {
    safeLog.warn('[ReceiptDailyReport] Missing RECEIPT_DAILY_REPORT_EMAIL_TO, skipping');
    return { sent: false, foreign: 0, needsReview: 0 };
  }

  if (!env.GMAIL_CLIENT_ID || !env.GMAIL_CLIENT_SECRET) {
    safeLog.warn('[ReceiptDailyReport] Gmail credentials not configured, skipping');
    return { sent: false, foreign: 0, needsReview: 0 };
  }

  const gmailRefreshToken = await resolveGmailRefreshToken(env);
  if (!gmailRefreshToken) {
    safeLog.warn('[ReceiptDailyReport] Gmail refresh token not found (env or D1), skipping', {
      remediation: '/api/gmail/auth',
    });
    return { sent: false, foreign: 0, needsReview: 0 };
  }

  const daysFallback = Number.parseInt(env.RECEIPT_DAILY_REPORT_DAYS || '14', 10);
  const limitFallback = Number.parseInt(env.RECEIPT_DAILY_REPORT_LIMIT || '50', 10);

  const daysRaw = options?.days ?? (Number.isFinite(daysFallback) && daysFallback > 0 ? daysFallback : 14);
  const limitRaw = options?.limit ?? (Number.isFinite(limitFallback) && limitFallback > 0 ? limitFallback : 50);

  const days = Math.max(1, Math.min(60, daysRaw));
  const limit = Math.max(1, Math.min(200, limitRaw));

  const foreignRows = await env.DB.prepare(
    `SELECT id, vendor_name, amount, currency, transaction_date, status,
            freee_receipt_id, freee_deal_id, error_code, error_message, created_at
     FROM receipts
     WHERE created_at >= datetime('now', ?)
       AND freee_receipt_id IS NOT NULL AND freee_receipt_id != ''
       AND (freee_deal_id IS NULL OR status = 'needs_review')
       AND UPPER(currency) != 'JPY'
     ORDER BY transaction_date DESC, created_at DESC
     LIMIT ?`
  )
    .bind(`-${days} days`, limit)
    .all<ReceiptRow>();

  const needsReviewRows = await env.DB.prepare(
    `SELECT id, vendor_name, amount, currency, transaction_date, status,
            freee_receipt_id, freee_deal_id, error_code, error_message, created_at
     FROM receipts
     WHERE created_at >= datetime('now', ?)
       AND status = 'needs_review'
     ORDER BY transaction_date DESC, created_at DESC
     LIMIT ?`
  )
    .bind(`-${days} days`, limit)
    .all<ReceiptRow>();

  const foreign = foreignRows.results ?? [];
  const needsReview = needsReviewRows.results ?? [];

  // Optional: fetch wallet_txn candidates for foreign receipts (best-effort)
  const includeCandidates = (env.RECEIPT_DAILY_REPORT_INCLUDE_FOREX_CANDIDATES || '').trim().toLowerCase() === 'true';
  let walletTxns: FreeeWalletTxn[] = [];
  if (includeCandidates && foreign.length > 0 && isFreeeIntegrationEnabled(env)) {
    try {
      const dates = foreign
        .map(r => r.transaction_date)
        .filter(Boolean)
        .sort();
      const start = addDaysIso(dates[0], -3);
      const end = addDaysIso(dates[dates.length - 1], 3);
      const freeeClient = createFreeeClient(env);
      walletTxns = await freeeClient.listWalletTxns({ startDate: start, endDate: end, limit: 200 });
    } catch (error) {
      safeLog.warn('[ReceiptDailyReport] Failed to fetch freee wallet_txns (continuing without candidates)', {
        error: error instanceof Error ? error.message : String(error),
      });
      walletTxns = [];
    }
  }

  const lines: string[] = [];
  lines.push('freee×Gmail レシート自動登録: 日次レポート');
  lines.push(`対象期間: 直近${days}日`);
  lines.push(`生成時刻(UTC): ${new Date().toISOString()}`);
  lines.push('');

  lines.push(`外貨(要手動): ${foreign.length}件`);
  if (foreign.length === 0) {
    lines.push('  (なし)');
  } else {
    for (const r of foreign.slice(0, limit)) {
      lines.push(`- ${formatReceiptLine(r)}`);

      if (walletTxns.length > 0) {
        const windowStart = addDaysIso(r.transaction_date, -3);
        const windowEnd = addDaysIso(r.transaction_date, 3);
        const candidates = walletTxns
          .filter(t => t.date >= windowStart && t.date <= windowEnd)
          .map(t => ({
            txn: t,
            scored: scoreWalletCandidate({
              receiptVendor: r.vendor_name,
              receiptDate: r.transaction_date,
              receiptCurrency: r.currency,
              receiptAmount: Number(r.amount || 0),
              txn: t,
            }),
          }))
          .sort((a, b) => b.scored.score - a.scored.score)
          .slice(0, 3);

        if (candidates.length > 0) {
          for (const c of candidates) {
            const implied = typeof c.scored.impliedFx === 'number' ? ` fx=${c.scored.impliedFx.toFixed(1)}` : '';
            lines.push(`    candidate: ${c.txn.date} | JPY ${c.txn.amount_jpy} | ${String(c.txn.description || '').slice(0, 50)} | score=${c.scored.score}${implied} (${c.scored.reasons.join(',')})`);
          }
        }
      }
    }
  }

  lines.push('');
  lines.push(`needs_review: ${needsReview.length}件`);
  if (needsReview.length === 0) {
    lines.push('  (なし)');
  } else {
    for (const r of needsReview.slice(0, limit)) {
      const note = r.error_code || r.error_message ? ` | err=${(r.error_code || '').slice(0, 40)} ${(r.error_message || '').slice(0, 80)}` : '';
      lines.push(`- ${formatReceiptLine(r)}${note}`);
    }
  }

  lines.push('');
  lines.push('対応方針(要点):');
  lines.push('- 外貨は、カード明細の日本円額と突合してfreee上で取引に証憑を添付する(自動は誤爆回避のため未確定)。');
  lines.push('- needs_review は、金額0/外部参照/分類低信頼など。必要に応じて手動で補正する。');

  const subject = `freee×Gmail レシート日次レポート (${foreign.length} foreign / ${needsReview.length} review)`;
  const bodyText = lines.join('\n');

  // Fail-soft: do not break the pipeline if Gmail send fails (missing scope, quota, etc.).
  try {
    await sendTextEmailViaGmailOAuth({
      clientId: env.GMAIL_CLIENT_ID,
      clientSecret: env.GMAIL_CLIENT_SECRET,
      refreshToken: gmailRefreshToken,
      to,
      subject,
      bodyText,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const insufficientScope = /\b403\b/.test(message) && /insufficient|permission|scope/i.test(message);
    safeLog.warn('[ReceiptDailyReport] Gmail send failed (continuing)', {
      insufficientScope,
      error: message.substring(0, 400),
      remediation: insufficientScope ? '/api/gmail/auth' : undefined,
    });

    // Optional: Discord alert (throttled) so you notice the broken daily report.
    if (insufficientScope && env.DISCORD_WEBHOOK_URL && env.CACHE) {
      try {
        const key = 'alerts:gmail_send_scope_missing';
        const already = await env.CACHE.get(key);
        if (!already) {
          await fetch(env.DISCORD_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              content: '[freee×Gmail] Gmail送信スコープ不足で日次レポート送信に失敗しました。対処: /api/gmail/auth',
            }),
          });
          await env.CACHE.put(key, '1', { expirationTtl: 60 * 60 * 6 });
        }
      } catch {
        // best-effort
      }
    }

    return { sent: false, foreign: foreign.length, needsReview: needsReview.length };
  }

  safeLog.info('[ReceiptDailyReport] Sent daily report email', {
    foreign: foreign.length,
    needsReview: needsReview.length,
  });

  return { sent: true, foreign: foreign.length, needsReview: needsReview.length };
}
