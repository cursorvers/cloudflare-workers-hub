import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/api-auth', () => ({
  verifyAPIKey: vi.fn(),
  extractUserIdFromKey: vi.fn(),
}));

vi.mock('../utils/tenant-isolation', () => ({
  resolveTenantContext: vi.fn(),
}));

vi.mock('../services/freee-client', () => ({
  createFreeeClient: vi.fn(),
}));

vi.mock('./receipt-search', () => ({
  handleReceiptDetail: vi.fn(),
  handleReceiptExport: vi.fn(),
  handleReceiptFileDownload: vi.fn(),
  handleReceiptSearch: vi.fn(),
}));

vi.mock('./receipt-sources-api', () => ({
  handleReceiptSourcesAPI: vi.fn(),
}));

vi.mock('./dlq-api', () => ({
  handleDLQAPI: vi.fn(),
}));

import { handleReceiptAPI } from './receipt-admin-api';
import { verifyAPIKey } from '../utils/api-auth';
import { resolveTenantContext } from '../utils/tenant-isolation';
import { createFreeeClient } from '../services/freee-client';
import { handleReceiptDetail } from './receipt-search';
import { handleReceiptSourcesAPI } from './receipt-sources-api';
import { handleDLQAPI } from './dlq-api';

function createEnv() {
  const updateRun = vi.fn().mockResolvedValue({});
  const failedRows = [
    { id: 'receipt-1', r2_object_key: 'receipts/default/1/file.pdf', file_hash: 'hash-1' },
  ];

  return {
    DB: {
      prepare: vi.fn((sql: string) => ({
        all: vi.fn().mockResolvedValue({ results: sql.includes("status = 'failed'") ? failedRows : [] }),
        bind: vi.fn().mockReturnThis(),
        run: updateRun,
      })),
    },
    RECEIPTS: {
      get: vi.fn().mockResolvedValue({
        blob: vi.fn().mockResolvedValue(new Blob(['receipt'])),
      }),
    },
    _updateRun: updateRun,
  } as any;
}

describe('handleReceiptAPI retry hardening', () => {
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
    vi.mocked(handleReceiptDetail).mockResolvedValue(new Response('detail'));
    vi.mocked(handleReceiptSourcesAPI).mockResolvedValue(new Response('sources'));
    vi.mocked(handleDLQAPI).mockResolvedValue(new Response('dlq'));
  });

  it('rejects retry without admin auth', async () => {
    vi.mocked(verifyAPIKey).mockReturnValue(false);

    const response = await handleReceiptAPI(
      new Request('https://example.com/api/receipts/retry', { method: 'POST' }),
      createEnv(),
      '/api/receipts/retry'
    );

    expect(response.status).toBe(401);
  });

  it('defaults retry to dry-run and does not write to freee or DB', async () => {
    vi.mocked(verifyAPIKey).mockReturnValue(true);
    const env = createEnv();
    const uploadReceipt = vi.fn();
    vi.mocked(createFreeeClient).mockReturnValue({ uploadReceipt } as any);

    const response = await handleReceiptAPI(
      new Request('https://example.com/api/receipts/retry', {
        method: 'POST',
        headers: { 'X-API-Key': 'admin-key', 'X-Tenant-Id': 'tenant-abc' },
      }),
      env,
      '/api/receipts/retry'
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.dry_run).toBe(true);
    expect(json.would_retry).toBe(1);
    expect(uploadReceipt).not.toHaveBeenCalled();
    expect(env._updateRun).not.toHaveBeenCalled();
  });

  it('requires explicit confirmation for retry execution', async () => {
    vi.mocked(verifyAPIKey).mockReturnValue(true);

    const response = await handleReceiptAPI(
      new Request('https://example.com/api/receipts/retry?dry_run=false', {
        method: 'POST',
        headers: { 'X-API-Key': 'admin-key', 'X-Tenant-Id': 'tenant-abc' },
      }),
      createEnv(),
      '/api/receipts/retry'
    );

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.required_confirm).toBe('execute-retry');
  });

  it('routes /api/receipts/sources to the sources handler instead of receipt detail', async () => {
    vi.mocked(verifyAPIKey).mockReturnValue(true);

    const response = await handleReceiptAPI(
      new Request('https://example.com/api/receipts/sources', {
        method: 'GET',
        headers: { 'X-API-Key': 'admin-key', 'X-Tenant-Id': 'tenant-abc' },
      }),
      createEnv(),
      '/api/receipts/sources'
    );

    expect(await response.text()).toBe('sources');
    expect(handleReceiptSourcesAPI).toHaveBeenCalledOnce();
    expect(handleReceiptDetail).not.toHaveBeenCalled();
  });

  it('routes /api/receipts/dlq to the dlq handler instead of receipt detail', async () => {
    const response = await handleReceiptAPI(
      new Request('https://example.com/api/receipts/dlq', { method: 'GET' }),
      createEnv(),
      '/api/receipts/dlq'
    );

    expect(await response.text()).toBe('dlq');
    expect(handleDLQAPI).toHaveBeenCalledOnce();
    expect(handleReceiptDetail).not.toHaveBeenCalled();
  });
});
