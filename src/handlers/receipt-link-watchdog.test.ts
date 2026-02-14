import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../services/freee-client', () => ({
  createFreeeClient: vi.fn(),
  ApiError: class ApiError extends Error {
    status: number;
    constructor(msg: string, status: number) {
      super(msg);
      this.status = status;
    }
  },
}));

import { createFreeeClient, ApiError } from '../services/freee-client';
import { runReceiptLinkWatchdog } from './receipt-link-watchdog';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('receipt-link-watchdog', () => {
  it('calls freee linkReceiptToDeal for recent rows with ids', async () => {
    const all = vi.fn(async () => ({
      results: [
        { id: 'r1', freee_receipt_id: '111', freee_deal_id: 222, r2_object_key: 'receipts/t/r1/receipt.pdf' },
        { id: 'r2', freee_receipt_id: '333', freee_deal_id: 444, r2_object_key: 'receipts/t/r2/receipt.pdf' },
      ],
    }));

    const prepare = vi.fn(() => ({
      bind: vi.fn(() => ({ all })),
    }));

    const linkReceiptToDeal = vi.fn(async () => undefined);
    vi.mocked(createFreeeClient).mockReturnValue({ linkReceiptToDeal } as any);

    const env = { DB: { prepare } } as any;

    const res = await runReceiptLinkWatchdog(env, { limit: 10, days: 7 });

    expect(res.scanned).toBe(2);
    expect(res.attempted).toBe(2);
    expect(res.ok).toBe(2);
    expect(res.errors).toBe(0);
    expect(res.reuploaded).toBe(0);

    expect(linkReceiptToDeal).toHaveBeenCalledTimes(2);
    expect(linkReceiptToDeal).toHaveBeenCalledWith(111, 222);
    expect(linkReceiptToDeal).toHaveBeenCalledWith(333, 444);
  });

  it('reuploads evidence from R2 when freee reports the receipt is deleted, then relinks', async () => {
    const all = vi.fn(async () => ({
      results: [
        { id: 'row1', freee_receipt_id: '111', freee_deal_id: 222, r2_object_key: 'receipts/t/row1/receipt.pdf' },
      ],
    }));

    const runUpdateReceipt = vi.fn(async () => ({ success: true }));
    const runUpdateDeal = vi.fn(async () => ({ success: true }));

    const prepare = vi.fn((sql: string) => {
      if (sql.includes('SELECT id, freee_receipt_id') && sql.includes('FROM receipts')) {
        return { bind: vi.fn(() => ({ all })) };
      }
      if (sql.startsWith('UPDATE receipts')) {
        return { bind: vi.fn(() => ({ run: runUpdateReceipt })) };
      }
      if (sql.startsWith('UPDATE receipt_deals')) {
        return { bind: vi.fn(() => ({ run: runUpdateDeal })) };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });

    const linkReceiptToDeal = vi
      .fn()
      .mockRejectedValueOnce(new ApiError('freee API error: 400 - 証憑は既に削除されています。', 400))
      .mockResolvedValueOnce(undefined);

    const uploadReceipt = vi.fn(async () => ({
      receipt: { id: 999, company_id: 1, description: '', receipt_metadatum: { file_name: 'receipt.pdf', file_size: 1 }, issue_date: '2026-02-14', document_type: 'receipt' },
    }));

    vi.mocked(createFreeeClient).mockReturnValue({ linkReceiptToDeal, uploadReceipt } as any);

    const r2Obj = {
      arrayBuffer: vi.fn(async () => new Uint8Array([1, 2, 3]).buffer),
    };
    const r2 = {
      get: vi.fn(async () => r2Obj),
    };

    const env = { DB: { prepare }, RECEIPTS: r2 } as any;

    const res = await runReceiptLinkWatchdog(env, { limit: 10, days: 7 });

    expect(res.scanned).toBe(1);
    expect(res.attempted).toBe(1);
    expect(res.ok).toBe(1);
    expect(res.errors).toBe(0);
    expect(res.reuploaded).toBe(1);

    expect(uploadReceipt).toHaveBeenCalledTimes(1);
    expect(linkReceiptToDeal).toHaveBeenCalledTimes(2);
    expect(linkReceiptToDeal).toHaveBeenNthCalledWith(1, 111, 222);
    expect(linkReceiptToDeal).toHaveBeenNthCalledWith(2, 999, 222);

    expect(runUpdateReceipt).toHaveBeenCalledTimes(1);
  });
});
