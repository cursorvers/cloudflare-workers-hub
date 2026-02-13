import { describe, expect, it, vi } from 'vitest';

import { handleRepairFreeeLinks } from './receipt-freee-repair';

function makeEnv(rows: any[]) {
  const db = {
    prepare: (_sql: string) => ({
      bind: (_limit: any) => ({
        all: async () => ({ results: rows }),
      }),
    }),
  } as any;

  return { DB: db } as any;
}

describe('handleRepairFreeeLinks', () => {
  it('counts ok / would_repair / conflict / skipped and does not mutate on dry_run', async () => {
    const env = makeEnv([
      { id: 'r1', freee_receipt_id: '101', freee_deal_id: '201' },
      { id: 'r2', freee_receipt_id: 102, freee_deal_id: 202 },
      { id: 'r3', freee_receipt_id: '103', freee_deal_id: '203' },
      { id: 'r4', freee_receipt_id: 'abc', freee_deal_id: '204' },
    ]);

    const getReceipt = vi.fn(async (receiptId: number) => {
      if (receiptId === 101) return { id: 101 }; // no deal_id => would repair
      if (receiptId === 102) return { id: 102, deal_id: 202 }; // ok
      if (receiptId === 103) return { id: 103, deal_id: 999 }; // conflict
      return { id: receiptId };
    });

    const linkReceiptToDeal = vi.fn(async () => {});

    const req = new Request('https://example.com/api/receipts/repair-freee-links?limit=10&dry_run=true', { method: 'POST' });
    const res = await handleRepairFreeeLinks(req, env, { getReceipt, linkReceiptToDeal });
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.dry_run).toBe(true);
    expect(json.scanned).toBe(4);
    expect(json.ok).toBe(1);
    expect(json.would_repair).toBe(1);
    expect(json.repaired).toBe(0);
    expect(json.conflicts).toBe(1);
    expect(json.skipped).toBe(1);
    expect(json.errors).toBe(0);

    expect(linkReceiptToDeal).not.toHaveBeenCalled();
  });

  it('repairs when dry_run=false and deal_id is missing', async () => {
    const env = makeEnv([{ id: 'r1', freee_receipt_id: 101, freee_deal_id: 201 }]);

    const getReceipt = vi.fn(async (_receiptId: number) => ({ id: 101 }));
    const linkReceiptToDeal = vi.fn(async () => {});

    const req = new Request('https://example.com/api/receipts/repair-freee-links?limit=10&dry_run=false', { method: 'POST' });
    const res = await handleRepairFreeeLinks(req, env, { getReceipt, linkReceiptToDeal });
    const json = await res.json();

    expect(json.dry_run).toBe(false);
    expect(json.repaired).toBe(1);
    expect(linkReceiptToDeal).toHaveBeenCalledWith(101, 201);
  });
});
