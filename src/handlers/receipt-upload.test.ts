import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { webcrypto, randomUUID as nodeRandomUUID } from 'node:crypto';

vi.mock('../utils/log-sanitizer', () => ({
  safeLog: Object.assign(vi.fn(), {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    log: vi.fn(),
  }),
  maskUserId: vi.fn((value: string) => value),
}));

vi.mock('../utils/cloudflare-access', () => ({
  authenticateWithAccess: vi.fn(),
  mapAccessUserToInternal: vi.fn(),
}));

vi.mock('../utils/tenant-isolation', () => ({
  getTenantContext: vi.fn(),
}));

vi.mock('../services/freee-client', () => ({
  createFreeeClient: vi.fn(),
  ApiError: class ApiError extends Error {},
}));

vi.mock('../services/workflow-state-machine', () => ({
  createStateMachine: vi.fn(),
}));

vi.mock('../services/freee-deal-service', () => ({
  createDealFromReceipt: vi.fn(),
}));

import { handleReceiptUpload } from './receipt-upload';
import { createFreeeClient } from '../services/freee-client';
import { createStateMachine } from '../services/workflow-state-machine';
import { createDealFromReceipt } from '../services/freee-deal-service';
import {
  authenticateWithAccess,
  mapAccessUserToInternal,
} from '../utils/cloudflare-access';
import { getTenantContext } from '../utils/tenant-isolation';

type MockDbStatement = {
  sql: string;
  bound: unknown[];
  bind: ReturnType<typeof vi.fn>;
  first: ReturnType<typeof vi.fn>;
  run: ReturnType<typeof vi.fn>;
};

type MockDb = {
  prepare: ReturnType<typeof vi.fn>;
  statements: MockDbStatement[];
};

function createMockDb(): MockDb {
  const statements: MockDbStatement[] = [];
  const prepare = vi.fn((sql: string) => {
    const statement: MockDbStatement = {
      sql,
      bound: [],
      bind: vi.fn((...args: unknown[]) => {
        statement.bound = args;
        return statement;
      }),
      first: vi.fn().mockResolvedValue(null),
      run: vi.fn().mockResolvedValue({}),
    };
    statements.push(statement);
    return statement;
  });
  return { prepare, statements };
}

function createRequest(): Request {
  const formData = new FormData();
  const file = new File(['hello world'], 'receipt.pdf', {
    type: 'application/pdf',
  });

  formData.set('file', file);
  formData.set('transaction_date', '2024-01-01');
  formData.set('vendor_name', 'ACME');
  formData.set('amount', '1200');
  formData.set('currency', 'JPY');
  formData.set('document_type', 'receipt');

  return new Request('http://localhost/api/receipts/upload', {
    method: 'POST',
    body: formData,
  });
}

function createEnv(db: MockDb, bucket: { put: ReturnType<typeof vi.fn> }) {
  return {
    DB: db,
    RECEIPTS: bucket,
    KV: {
      get: vi.fn().mockResolvedValue('encrypted-refresh-token'),
    },
    FREEE_CLIENT_ID: 'client-id',
    FREEE_CLIENT_SECRET: 'client-secret',
    FREEE_COMPANY_ID: '123',
    FREEE_REDIRECT_URI: 'https://example.com/callback',
    FREEE_ENCRYPTION_KEY: 'encryption-key',
  } as any;
}

let randomUUIDSpy: ReturnType<typeof vi.spyOn> | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2024-02-01T00:00:00.000Z'));

  if (!globalThis.crypto) {
    (globalThis as any).crypto = webcrypto;
  }

  if (typeof globalThis.crypto.randomUUID !== 'function') {
    (globalThis.crypto as any).randomUUID = nodeRandomUUID;
  }

  randomUUIDSpy = vi
    .spyOn(globalThis.crypto, 'randomUUID')
    .mockReturnValue('11111111-1111-1111-1111-111111111111');

  vi.mocked(authenticateWithAccess).mockResolvedValue({
    verified: true,
    email: 'user@example.com',
  } as any);

  vi.mocked(mapAccessUserToInternal).mockResolvedValue({
    userId: 'user-123',
    role: 'user',
  } as any);

  vi.mocked(getTenantContext).mockResolvedValue({ tenantId: 'tenant-abc' } as any);

  vi.mocked(createStateMachine).mockReturnValue({
    transition: vi.fn().mockResolvedValue(undefined),
    complete: vi.fn().mockResolvedValue(undefined),
    recordError: vi.fn().mockResolvedValue(undefined),
  } as any);

  vi.mocked(createFreeeClient).mockReturnValue({
    uploadReceipt: vi.fn().mockResolvedValue({
      receipt: { id: 987 },
    }),
  } as any);

  vi.mocked(createDealFromReceipt).mockResolvedValue({
    dealId: null,
    partnerId: null,
    mappingConfidence: 0.5,
    status: 'needs_review',
  } as any);
});

afterEach(() => {
  randomUUIDSpy?.mockRestore();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('handleReceiptUpload', () => {
  it('updates freee_receipt_id and passes tenant_id to deal creation', async () => {
    const db = createMockDb();
    const bucket = { put: vi.fn().mockResolvedValue(undefined) };
    const env = createEnv(db, bucket);
    const request = createRequest();

    const response = await handleReceiptUpload(request, env);

    expect(response.status).toBe(200);

    const updateStatement = db.statements.find((statement) =>
      statement.sql.includes('UPDATE receipts SET freee_receipt_id')
    );

    expect(updateStatement).toBeDefined();

    const expectedReceiptId = '11111111111111111111111111111111';

    expect(updateStatement?.bound).toEqual([
      '987',
      expectedReceiptId,
    ]);

    expect(createDealFromReceipt).toHaveBeenCalledTimes(1);
    const receiptInput = vi.mocked(createDealFromReceipt).mock.calls[0][1] as any;
    expect(receiptInput.tenant_id).toBe('tenant-abc');
  });
});
