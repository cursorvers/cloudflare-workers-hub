import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/tenant-isolation', () => ({
  resolveTenantContext: vi.fn(),
}));

vi.mock('../services/ai-receipt-classifier', () => ({
  classifyReceipt: vi.fn(),
}));

import { handleRepairHtmlReceiptText } from './receipt-html-text-repair';
import { resolveTenantContext } from '../utils/tenant-isolation';
import { classifyReceipt } from '../services/ai-receipt-classifier';

function createEnv() {
  return {
    DB: {
      prepare: vi.fn(() => ({
        bind: vi.fn().mockReturnThis(),
        all: vi.fn().mockResolvedValue({
          results: [
            {
              id: 'receipt-1',
              tenant_id: 'tenant-abc',
              r2_object_key: 'receipts/tenant-abc/receipt-1/receipt.html',
              vendor_name: 'Vendor',
              amount: 1000,
              currency: 'JPY',
              transaction_date: '2024-01-01',
              account_category: 'Supplies',
              classification_confidence: 0.9,
              freee_receipt_id: null,
              freee_deal_id: null,
              status: 'completed',
            },
          ],
        }),
        run: vi.fn().mockResolvedValue({}),
      })),
    },
    RECEIPTS: {
      head: vi.fn().mockResolvedValue(null),
      get: vi.fn().mockRejectedValue(new Error('r2 unavailable')),
    },
  } as any;
}

describe('handleRepairHtmlReceiptText', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveTenantContext).mockResolvedValue({
      ok: true,
      tenantContext: {
        tenantId: 'tenant-abc',
        userId: 'admin-1',
        role: 'admin',
        authSource: 'api_key',
      },
    } as any);
    vi.mocked(classifyReceipt).mockResolvedValue({
      vendor_name: 'Vendor',
      amount: 1000,
      currency: 'JPY',
      account_category: 'Supplies',
      confidence: 0.9,
      method: 'ai_assisted',
    } as any);
  });

  it('returns 207 when any row errors', async () => {
    const response = await handleRepairHtmlReceiptText(
      new Request('https://example.com/api/receipts/repair-html-text?dry_run=false', {
        method: 'POST',
        headers: { 'X-Tenant-Id': 'tenant-abc' },
      }),
      createEnv()
    );

    expect(response.status).toBe(207);
    const json = await response.json();
    expect(json.success).toBe(false);
    expect(json.errors).toBe(1);
  });
});
