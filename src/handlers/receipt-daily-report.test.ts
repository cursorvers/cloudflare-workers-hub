import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../services/gmail-sender', () => ({
  sendTextEmailViaGmailOAuth: vi.fn(async () => ({ id: 'm1' })),
}));

import { sendTextEmailViaGmailOAuth } from '../services/gmail-sender';
import { sendReceiptDailyReport } from './receipt-daily-report';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('receipt-daily-report', () => {
  it('skips when disabled', async () => {
    const env = { RECEIPT_DAILY_REPORT_ENABLED: 'false' } as any;
    const res = await sendReceiptDailyReport(env);
    expect(res.sent).toBe(false);
    expect(vi.mocked(sendTextEmailViaGmailOAuth)).not.toHaveBeenCalled();
  });

  it('sends a report email with counts', async () => {
    const foreignAll = vi.fn(async () => ({
      results: [
        {
          id: 'r1', vendor_name: 'Stripe', amount: 29, currency: 'USD', transaction_date: '2026-02-10',
          status: 'completed', freee_receipt_id: '101', freee_deal_id: null, error_code: null, error_message: null, created_at: '2026-02-10',
        },
      ],
    }));
    const reviewAll = vi.fn(async () => ({
      results: [
        {
          id: 'r2', vendor_name: 'X', amount: 0, currency: 'JPY', transaction_date: '2026-02-11',
          status: 'needs_review', freee_receipt_id: '102', freee_deal_id: 201, error_code: 'QUALITY', error_message: 'amount=0', created_at: '2026-02-11',
        },
      ],
    }));

    const prepare = vi.fn((sql: string) => {
      if (sql.includes('UPPER(currency) !=')) {
        return { bind: vi.fn(() => ({ all: foreignAll })) };
      }
      if (sql.includes("status = 'needs_review'")) {
        return { bind: vi.fn(() => ({ all: reviewAll })) };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });

    const env = {
      DB: { prepare },
      RECEIPT_DAILY_REPORT_ENABLED: 'true',
      RECEIPT_DAILY_REPORT_EMAIL_TO: 'me@example.com',
      GMAIL_CLIENT_ID: 'cid',
      GMAIL_CLIENT_SECRET: 'cs',
      GMAIL_REFRESH_TOKEN: 'rt',
      // Do not include forex candidates in this unit test.
      RECEIPT_DAILY_REPORT_INCLUDE_FOREX_CANDIDATES: 'false',
    } as any;

    const res = await sendReceiptDailyReport(env, { days: 14, limit: 50 });

    expect(res.sent).toBe(true);
    expect(res.foreign).toBe(1);
    expect(res.needsReview).toBe(1);

    expect(vi.mocked(sendTextEmailViaGmailOAuth)).toHaveBeenCalledTimes(1);
    const call = vi.mocked(sendTextEmailViaGmailOAuth).mock.calls[0][0];
    expect(call.to).toBe('me@example.com');
    expect(call.subject).toContain('foreign');
    expect(call.bodyText).toContain('Stripe');
    expect(call.bodyText).toContain('needs_review');
  });
});
