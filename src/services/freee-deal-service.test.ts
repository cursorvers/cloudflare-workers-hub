import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils/log-sanitizer', () => ({
  safeLog: Object.assign(vi.fn(), {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    log: vi.fn(),
  }),
}));

vi.mock('./freee-client', () => ({
  createFreeeClient: vi.fn(),
}));

vi.mock('./freee-master-cache', () => ({
  getAccountItems: vi.fn(),
  getTaxes: vi.fn(),
  findPartnerByName: vi.fn(),
  createPartner: vi.fn(),
}));

vi.mock('./freee-account-selector', () => ({
  selectAccountItemForReceipt: vi.fn(),
}));

import { createDealFromReceipt } from './freee-deal-service';
import { createFreeeClient } from './freee-client';
import {
  getAccountItems,
  getTaxes,
  findPartnerByName,
  createPartner,
} from './freee-master-cache';
import { selectAccountItemForReceipt } from './freee-account-selector';

type MockDbStatement = {
  bind: ReturnType<typeof vi.fn>;
  first: ReturnType<typeof vi.fn>;
  run: ReturnType<typeof vi.fn>;
};

function createMockDb() {
  const prepare = vi.fn((sql: string) => {
    const statement: MockDbStatement = {
      bind: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue(null),
      run: vi.fn().mockResolvedValue({}),
    } as MockDbStatement;
    return statement;
  });

  return { prepare };
}

const baseReceipt = {
  id: 'receipt-1',
  freee_receipt_id: 555,
  file_hash: 'hash-123',
  vendor_name: 'Test Vendor',
  amount: 1200,
  transaction_date: '2024-01-01',
  account_category: 'Supplies',
  classification_confidence: 1,
};

function setup() {
  const requestMock = vi
    .fn()
    .mockResolvedValueOnce({ deal: { id: 101 } })
    .mockResolvedValueOnce({ receipt: { id: 555 } });

  vi.mocked(createFreeeClient).mockReturnValue({
    request: requestMock,
    getAccessTokenPublic: vi.fn().mockResolvedValue('token'),
    getCompanyId: vi.fn().mockResolvedValue('123'),
  } as any);

  vi.mocked(getAccountItems).mockResolvedValue([]);
  vi.mocked(getTaxes).mockResolvedValue([]);
  vi.mocked(findPartnerByName).mockResolvedValue(null);
  vi.mocked(createPartner).mockResolvedValue({ id: 10, name: 'Vendor' } as any);
  vi.mocked(selectAccountItemForReceipt).mockResolvedValue({
    accountItemId: 1,
    taxCode: 2,
    mappingConfidence: 1,
    mappingMethod: 'exact',
    provider: 'workers_ai',
    candidateCount: 10,
    scoreGap: 0.5,
  } as any);

  const env = {
    DB: createMockDb(),
  } as any;

  return { env, requestMock };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('buildIdempotencyKey (via createDealFromReceipt)', () => {
  it('uses tenant_id prefix with file_hash when tenant_id is present', async () => {
    const { env, requestMock } = setup();

    await createDealFromReceipt(env, {
      ...baseReceipt,
      tenant_id: 'tenant-abc',
    } as any);

    expect(requestMock).toHaveBeenCalled();
    expect(requestMock.mock.calls[0][3]).toBe('tenant-abc:hash-123');
    expect(requestMock.mock.calls[1][3]).toBe('tenant-abc:hash-123');
  });

  it('defaults tenant_id to "default" when absent', async () => {
    const { env, requestMock } = setup();

    await createDealFromReceipt(env, {
      ...baseReceipt,
      tenant_id: undefined,
    } as any);

    expect(requestMock.mock.calls[0][3]).toBe('default:hash-123');
    expect(requestMock.mock.calls[1][3]).toBe('default:hash-123');
  });

  it('falls back to receipt id when file_hash is absent', async () => {
    const { env, requestMock } = setup();

    await createDealFromReceipt(env, {
      ...baseReceipt,
      file_hash: null,
      tenant_id: 'tenant-xyz',
    } as any);

    expect(requestMock.mock.calls[0][3]).toBe('tenant-xyz:receipt-1');
    expect(requestMock.mock.calls[1][3]).toBe('tenant-xyz:receipt-1');
  });

  it('throws when both file_hash and receipt id are absent', async () => {
    const { env } = setup();

    await expect(
      createDealFromReceipt(env, {
        ...baseReceipt,
        id: '',
        file_hash: null,
      } as any)
    ).rejects.toThrow('Receipt idempotency key is required');
  });
});

describe('createDealFromReceipt - existing deal early return', () => {
  it('returns existing deal record (partner_id null) without calling freee APIs', async () => {
    const statement: MockDbStatement = {
      bind: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue({
        deal_id: 9001,
        partner_id: null,
        mapping_confidence: 0.42,
        status: 'created',
      }),
      run: vi.fn(),
    } as any;

    const env = {
      FREEE_COMPANY_ID: '123',
      DB: {
        prepare: vi.fn().mockReturnValue(statement),
      },
    } as any;

    const result = await createDealFromReceipt(env, { ...baseReceipt } as any);

    expect(result).toEqual(
      expect.objectContaining({
        dealId: 9001,
        partnerId: null,
        mappingConfidence: 0.42,
        status: 'created',
      })
    );
    expect(vi.mocked(createFreeeClient)).not.toHaveBeenCalled();
  });

  it('returns existing deal record (partner_id present) and preserves status', async () => {
    const statement: MockDbStatement = {
      bind: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue({
        deal_id: 9002,
        partner_id: 77,
        mapping_confidence: 0.9,
        status: 'needs_review',
      }),
      run: vi.fn(),
    } as any;

    const env = {
      FREEE_COMPANY_ID: '123',
      DB: {
        prepare: vi.fn().mockReturnValue(statement),
      },
    } as any;

    const result = await createDealFromReceipt(env, { ...baseReceipt } as any);

    expect(result).toEqual(
      expect.objectContaining({
        dealId: 9002,
        partnerId: 77,
        mappingConfidence: 0.9,
        status: 'needs_review',
      })
    );
    expect(vi.mocked(createFreeeClient)).not.toHaveBeenCalled();
  });
});

describe('createDealFromReceipt - low confidence path', () => {
  it('returns needs_review when weighted confidence is below threshold (ambiguous gap)', async () => {
    const { env, requestMock } = setup();
    vi.mocked(selectAccountItemForReceipt).mockResolvedValue({
      accountItemId: 1,
      taxCode: 2,
      mappingConfidence: 0.3,
      mappingMethod: 'exact',
      provider: 'workers_ai',
      candidateCount: 10,
      scoreGap: 0.02,
    } as any);

    const { safeLog } = (await import('../utils/log-sanitizer')) as any;

    const result = await createDealFromReceipt(env, { ...baseReceipt } as any);

    expect(result).toEqual(
      expect.objectContaining({
        dealId: null,
        partnerId: null,
        mappingConfidence: 0.3,
        status: 'needs_review',
        accountItemId: 1,
        taxCode: 2,
      })
    );
    expect(requestMock).not.toHaveBeenCalled();
    expect(vi.mocked(findPartnerByName)).not.toHaveBeenCalled();
    expect(vi.mocked(createPartner)).not.toHaveBeenCalled();
    expect(vi.mocked(safeLog)).toHaveBeenCalledWith(
      env,
      'info',
      '[FreeeDealService] confidence below auto threshold',
      // weighted: mapping=0.3*0.7 + classification=1*0.3 = 0.51
      expect.objectContaining({ receiptId: 'receipt-1', confidence: 0.51 })
    );
  });

  it('creates deal even when classification_confidence is negative if mapping is strong (weighted average)', async () => {
    // With weighted avg: mapping=1*0.7 + classification=0*0.3 = 0.7 > 0.55 threshold → created
    const { env, requestMock } = setup();
    vi.mocked(selectAccountItemForReceipt).mockResolvedValue({
      accountItemId: 1,
      taxCode: 2,
      mappingConfidence: 1,
      mappingMethod: 'exact',
      provider: 'workers_ai',
      candidateCount: 10,
      scoreGap: 0.5,
    } as any);

    const result = await createDealFromReceipt(env, {
      ...baseReceipt,
      account_category: null,
      classification_confidence: null,
      confidence: -0.2,
    } as any);

    // Strong mapping confidence (1.0) should override weak classification
    // weighted: mapping=1*0.7 + classification=0*0.3 = 0.7 > 0.55 → created
    expect(result.status).toBe('created');
    expect(result.dealId).toBe(101);
    expect(requestMock).toHaveBeenCalled();
  });
});

describe('createDealFromReceipt - happy path full flow', () => {
  it('creates deal, links receipt, records mapping in DB, and returns created', async () => {
    const { env, requestMock } = setup();
    vi.mocked(selectAccountItemForReceipt).mockResolvedValue({
      accountItemId: 111,
      taxCode: 222,
      mappingConfidence: 1,
      mappingMethod: 'exact',
      provider: 'workers_ai',
      candidateCount: 10,
      scoreGap: 0.5,
    } as any);

    const result = await createDealFromReceipt(env, { ...baseReceipt } as any);

    expect(result).toEqual(
      expect.objectContaining({
        dealId: 101,
        partnerId: 10,
        mappingConfidence: 1,
        status: 'created',
        accountItemId: 111,
        taxCode: 222,
      })
    );

    expect(requestMock).toHaveBeenCalledTimes(2);
    expect(requestMock.mock.calls[0][0]).toBe('POST');
    expect(requestMock.mock.calls[0][1]).toBe('/deals');
    expect(requestMock.mock.calls[0][2]).toEqual({
      company_id: 123,
      issue_date: '2024-01-01',
      type: 'expense',
      partner_id: 10,
      details: [
        {
          account_item_id: 111,
          tax_code: 222,
          amount: 1200,
          description: 'Vendor',
        },
      ],
    });

    expect(requestMock.mock.calls[1][0]).toBe('PUT');
    expect(requestMock.mock.calls[1][1]).toBe('/receipts/555');
    expect(requestMock.mock.calls[1][2]).toEqual({
      company_id: 123,
      deal_id: 101,
    });

    expect(env.DB.prepare).toHaveBeenCalledTimes(2);
    expect(env.DB.prepare.mock.calls[0][0]).toContain(
      'SELECT deal_id, partner_id, mapping_confidence, status FROM receipt_deals'
    );
    expect(env.DB.prepare.mock.calls[1][0]).toContain('INSERT INTO receipt_deals');

    const insertStmt = env.DB.prepare.mock.results[1].value as MockDbStatement;
    expect(insertStmt.bind).toHaveBeenCalledWith(
      'receipt-1',
      101,
      10,
      1,
      'created',
      'default:hash-123',
      555
    );
    expect(insertStmt.run).toHaveBeenCalled();
  });

  it('uses existing partner when found (does not create new partner)', async () => {
    const { env, requestMock } = setup();
    vi.mocked(findPartnerByName).mockResolvedValue({
      id: 99,
      name: 'Existing Partner',
    } as any);

    const result = await createDealFromReceipt(env, { ...baseReceipt } as any);

    expect(result.partnerId).toBe(99);
    expect(vi.mocked(createPartner)).not.toHaveBeenCalled();
    expect(requestMock.mock.calls[0][2]).toEqual(
      expect.objectContaining({ partner_id: 99 })
    );
  });

  it('falls back to "Unknown" when vendor_name is blank after trim', async () => {
    const { env } = setup();

    await createDealFromReceipt(env, {
      ...baseReceipt,
      vendor_name: '   ',
    } as any);

    expect(vi.mocked(createPartner)).toHaveBeenCalledWith(
      env,
      'token',
      'Unknown'
    );
  });
});

describe('createDealFromReceipt - error handling and edge cases', () => {
  it('throws when freee_receipt_id is missing (after deal creation)', async () => {
    const { env, requestMock } = setup();

    await expect(
      createDealFromReceipt(env, {
        ...baseReceipt,
        freee_receipt_id: null,
      } as any)
    ).rejects.toThrow('freee receipt id is required to link deals');

    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestMock.mock.calls[0][1]).toBe('/deals');
  });

  it('does not require FREEE_COMPANY_ID env var when getCompanyId is available', async () => {
    const { env } = setup();
    env.FREEE_COMPANY_ID = undefined;

    const result = await createDealFromReceipt(env, { ...baseReceipt } as any);
    expect(result.status).toBeDefined();
    const client = vi.mocked(createFreeeClient).mock.results[0]?.value as any;
    expect(client.getCompanyId).toHaveBeenCalled();
  });

  it('throws when DB binding is missing (getExistingDeal)', async () => {
    const { env } = setup();
    env.DB = undefined;

    await expect(createDealFromReceipt(env, { ...baseReceipt } as any)).rejects.toThrow(
      'D1 database binding is required'
    );
  });

  it('throws when FreeeClient.getAccessTokenPublic() is not available', async () => {
    const { env } = setup();
    vi.mocked(createFreeeClient).mockReturnValue({
      request: vi.fn(),
      getCompanyId: vi.fn().mockResolvedValue('123'),
    } as any);

    await expect(createDealFromReceipt(env, { ...baseReceipt } as any)).rejects.toThrow(
      'FreeeClient.getAccessTokenPublic() is required for master cache'
    );
  });

  it('logs warn when weighted confidence is between 0.7 and 0.9 and still creates a deal', async () => {
    const { env } = setup();
    vi.mocked(selectAccountItemForReceipt).mockResolvedValue({
      accountItemId: 1,
      taxCode: 2,
      mappingConfidence: 0.8,
      mappingMethod: 'exact',
      provider: 'workers_ai',
      candidateCount: 10,
      scoreGap: 0.1,
    } as any);

    const { safeLog } = (await import('../utils/log-sanitizer')) as any;

    const result = await createDealFromReceipt(env, { ...baseReceipt } as any);

    // weighted: 0.8*0.7 + 1*0.3 = 0.86. Above 0.55 threshold → created
    expect(result.status).toBe('created');
    expect(vi.mocked(safeLog)).toHaveBeenCalledWith(
      env,
      'warn',
      '[FreeeDealService] confidence below auto threshold',
      expect.objectContaining({ receiptId: 'receipt-1' })
    );
  });

  it('treats NaN mapping confidence as low-confidence: returns needs_review without creating a deal', async () => {
    const { env } = setup();
    const { safeLog } = (await import('../utils/log-sanitizer')) as any;
    vi.mocked(selectAccountItemForReceipt).mockResolvedValue({
      accountItemId: 1,
      taxCode: 2,
      mappingConfidence: Number.NaN,
      mappingMethod: 'exact',
      provider: 'workers_ai',
      candidateCount: 10,
      scoreGap: 0.01,
    } as any);

    const result = await createDealFromReceipt(env, { ...baseReceipt } as any);

    expect(result.dealId).toBe(null);
    expect(result.partnerId).toBe(null);
    expect(result.mappingConfidence).toBe(0);
    expect(result.status).toBe('needs_review');
    expect(result.accountItemId).toBe(1);
    expect(result.taxCode).toBe(2);
    // Should not mutate freee when confidence is invalid/low.
    const client = vi.mocked(createFreeeClient).mock.results[0]?.value as any;
    expect(client.request).not.toHaveBeenCalled();
    // weighted: mapping=0*0.7 + classification=1*0.3 = 0.3
    expect(vi.mocked(safeLog)).toHaveBeenCalledWith(
      env,
      'info',
      '[FreeeDealService] confidence below auto threshold',
      expect.objectContaining({ receiptId: 'receipt-1', confidence: 0.3 })
    );
  });

  it('returns needs_review and does not create/link deal when selector returns invalid IDs', async () => {
    const { env, requestMock } = setup();
    const { safeLog } = (await import('../utils/log-sanitizer')) as any;
    vi.mocked(selectAccountItemForReceipt).mockResolvedValue({
      accountItemId: 0, // invalid
      taxCode: 2,
      mappingConfidence: 1,
      mappingMethod: 'exact',
      provider: 'workers_ai',
      candidateCount: 10,
      scoreGap: 0.5,
    } as any);

    const result = await createDealFromReceipt(env, { ...baseReceipt } as any);

    expect(result.status).toBe('needs_review');
    expect(result.dealId).toBe(null);
    expect(result.partnerId).toBe(null);
    expect(result.accountItemId).toBe(null);
    expect(result.taxCode).toBe(2); // taxCode is valid but account item is not
    expect(requestMock).not.toHaveBeenCalled();
    expect(vi.mocked(safeLog)).toHaveBeenCalledWith(
      env,
      'warn',
      '[FreeeDealService] invalid account/tax selection (needs review)',
      expect.objectContaining({ receiptId: 'receipt-1', accountItemId: 0, taxCode: 2 })
    );
  });

  it('throws from recordDealLink when DB binding disappears mid-flow', async () => {
    // Use a getter so we can satisfy getExistingDeal but fail in recordDealLink.
    const db = createMockDb();
    let accessCount = 0;
    const env = {
      FREEE_COMPANY_ID: '123',
      get DB() {
        accessCount += 1;
        // getExistingDeal: 1) if (!env.DB) 2) env.DB.prepare(...)
        // recordDealLink: 3) if (!env.DB) -> throw
        return accessCount <= 2 ? db : undefined;
      },
    } as any;

    // Reuse "setup" defaults for non-DB mocks.
    const requestMock = vi
      .fn()
      .mockResolvedValueOnce({ deal: { id: 101 } })
      .mockResolvedValueOnce({ receipt: { id: 555 } });
    vi.mocked(createFreeeClient).mockReturnValue({
      request: requestMock,
      getAccessTokenPublic: vi.fn().mockResolvedValue('token'),
      getCompanyId: vi.fn().mockResolvedValue('123'),
    } as any);
    vi.mocked(getAccountItems).mockResolvedValue([]);
    vi.mocked(getTaxes).mockResolvedValue([]);
    vi.mocked(findPartnerByName).mockResolvedValue(null);
    vi.mocked(createPartner).mockResolvedValue({ id: 10, name: 'Vendor' } as any);
    vi.mocked(selectAccountItemForReceipt).mockResolvedValue({
      accountItemId: 1,
      taxCode: 2,
      mappingConfidence: 1,
      mappingMethod: 'exact',
      provider: 'workers_ai',
      candidateCount: 10,
      scoreGap: 0.5,
    } as any);

    await expect(createDealFromReceipt(env, { ...baseReceipt } as any)).rejects.toThrow(
      'D1 database binding is required'
    );
  });
});
