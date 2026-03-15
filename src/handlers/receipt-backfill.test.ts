import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/log-sanitizer', () => ({
  safeLog: Object.assign(vi.fn(), {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    log: vi.fn(),
  }),
}));

vi.mock('../services/ai-receipt-classifier', () => ({
  classifyReceipt: vi.fn(),
}));

vi.mock('../services/freee-deal-service', () => ({
  createDealFromReceipt: vi.fn(),
}));

vi.mock('../utils/tenant-isolation', () => ({
  resolveTenantContext: vi.fn(),
}));

import { handleReceiptBackfill } from './receipt-backfill';
import { classifyReceipt } from '../services/ai-receipt-classifier';
import { createDealFromReceipt } from '../services/freee-deal-service';
import { resolveTenantContext } from '../utils/tenant-isolation';

function createEnv(overrides?: { receipts?: Array<Record<string, unknown>> }) {
  const updateRun = vi.fn().mockResolvedValue({});
  const receipts = overrides?.receipts ?? [
    {
      id: 'receipt-1',
      r2_object_key: 'receipts/default/1/file.pdf',
      file_hash: 'hash-1',
      vendor_name: 'Vendor',
      amount: 1200,
      currency: 'JPY',
      transaction_date: '2024-01-01',
      account_category: 'Supplies',
      classification_confidence: 0.5,
      freee_receipt_id: '321',
      source_type: 'upload',
    },
  ];

  return {
    DB: {
      prepare: vi.fn(() => ({
        all: vi.fn().mockResolvedValue({ results: receipts }),
        bind: vi.fn().mockReturnThis(),
        run: updateRun,
      })),
    },
    RECEIPTS: {
      get: vi.fn().mockResolvedValue(null),
    },
    _updateRun: updateRun,
  } as any;
}

describe('handleReceiptBackfill hardening', () => {
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
  });

  it('defaults to dry-run preview and avoids mutations', async () => {
    const env = createEnv();

    const response = await handleReceiptBackfill(
      new Request('https://example.com/api/receipts/backfill', {
        method: 'POST',
        headers: { 'X-Tenant-Id': 'tenant-abc' },
      }),
      env
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.dry_run).toBe(true);
    expect(json.summary.wouldAttemptDeal).toBe(1);
    expect(vi.mocked(classifyReceipt)).not.toHaveBeenCalled();
    expect(vi.mocked(createDealFromReceipt)).not.toHaveBeenCalled();
    expect(env._updateRun).not.toHaveBeenCalled();
  });

  it('requires explicit confirmation for execution', async () => {
    const response = await handleReceiptBackfill(
      new Request('https://example.com/api/receipts/backfill?dry_run=false', {
        method: 'POST',
        headers: { 'X-Tenant-Id': 'tenant-abc' },
      }),
      createEnv()
    );

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.required_confirm).toBe('execute-backfill');
  });

  it('dry-run preview reports deal attempts using the actual execution gate, not currency heuristics', async () => {
    const env = createEnv({
      receipts: [
        {
          id: 'receipt-usd',
          r2_object_key: 'receipts/default/1/file.pdf',
          file_hash: 'hash-usd',
          vendor_name: 'Foreign Vendor',
          amount: 25,
          currency: 'USD',
          transaction_date: '2024-01-01',
          account_category: 'Travel',
          classification_confidence: 0.5,
          freee_receipt_id: '555',
          source_type: 'upload',
        },
      ],
    });

    const response = await handleReceiptBackfill(
      new Request('https://example.com/api/receipts/backfill', {
        method: 'POST',
        headers: { 'X-Tenant-Id': 'tenant-abc' },
      }),
      env
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.summary.wouldAttemptDeal).toBe(1);
    expect(json.results[0].would_create_deal).toBe(true);
    expect(json.results[0].status).toBe('would_attempt_deal');
  });
});
