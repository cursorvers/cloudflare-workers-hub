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

import { createFreeeClient } from '../services/freee-client';
import { runReceiptLinkWatchdog } from './receipt-link-watchdog';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('receipt-link-watchdog', () => {
  it('calls freee linkReceiptToDeal for recent rows with ids', async () => {
    const all = vi.fn(async () => ({
      results: [
        { id: 'r1', freee_receipt_id: '111', freee_deal_id: 222 },
        { id: 'r2', freee_receipt_id: '333', freee_deal_id: 444 },
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

    expect(linkReceiptToDeal).toHaveBeenCalledTimes(2);
    expect(linkReceiptToDeal).toHaveBeenCalledWith(111, 222);
    expect(linkReceiptToDeal).toHaveBeenCalledWith(333, 444);
  });
});
