import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/api-auth', () => ({
  verifyAPIKey: vi.fn(),
}));

vi.mock('../fugue/autopilot/auth', () => ({
  authenticateBearer: vi.fn(),
}));

vi.mock('../services/finance-automation', () => ({
  FINANCE_AUTOMATION_CONFIRM_TOKEN: 'execute-finance-automation',
  FINANCE_OPERATION_IDS: ['poll_gmail', 'repair_html_text', 'retry_failed', 'repair_freee_links', 'backfill_receipts'],
  collectFinanceAutomationSnapshot: vi.fn(),
  runFinanceAutomation: vi.fn(),
}));

vi.mock('../utils/tenant-isolation', () => ({
  resolveTenantContext: vi.fn(),
}));

import { verifyAPIKey } from '../utils/api-auth';
import { authenticateBearer } from '../fugue/autopilot/auth';
import { collectFinanceAutomationSnapshot, runFinanceAutomation } from '../services/finance-automation';
import { resolveTenantContext } from '../utils/tenant-isolation';
import { handleFinanceAutomationAPI } from './finance-automation-api';

function createEnv(overrides?: Record<string, unknown>) {
  return {
    AUTOPILOT_API_KEY: 'autopilot-key',
    ADMIN_API_KEY: 'admin-key',
    ...overrides,
  } as any;
}

describe('handleFinanceAutomationAPI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(verifyAPIKey).mockReturnValue(false);
    vi.mocked(authenticateBearer).mockReturnValue({ authenticated: false, reason: 'nope' } as any);
    vi.mocked(collectFinanceAutomationSnapshot).mockResolvedValue({
      generatedAt: '2026-03-09T00:00:00.000Z',
      overview: {
        totalReceipts: 10,
        failedReceipts: 1,
        receiptsNeedingReview: 2,
        receiptsPendingDeal: 3,
        receiptsWithLinkedIds: 4,
        htmlReceipts: 5,
        lowConfidenceReceipts: 2,
        freeeNotFoundCandidates: 1,
        latestReceiptCreatedAt: '2026-03-09 00:00:00',
      },
      triage: {
        duplicates: { count: 1, samples: [] },
        notFound: { count: 1, samples: [] },
        misclassification: { count: 2, samples: [] },
      },
      recommendedOperations: [],
      recommendedPipeline: 'receipts_control_tower',
    } as any);
    vi.mocked(runFinanceAutomation).mockResolvedValue({
      applied: false,
      dryRun: true,
      pipeline: 'receipts_control_tower',
      operations: [],
    } as any);
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

  it('rejects unauthorized status requests', async () => {
    const response = await handleFinanceAutomationAPI(
      new Request('https://example.com/api/finance/status'),
      createEnv(),
      '/api/finance/status'
    );

    expect(response.status).toBe(401);
  });

  it('returns status snapshot for admin auth', async () => {
    vi.mocked(verifyAPIKey).mockReturnValue(true);

    const response = await handleFinanceAutomationAPI(
      new Request('https://example.com/api/finance/status?sample_limit=7', {
        headers: { 'X-API-Key': 'admin-key' },
      }),
      createEnv(),
      '/api/finance/status'
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.controlPlane).toBe('finance-backend');
    expect(json.compatibleWith).toContain('fugue');
    expect(collectFinanceAutomationSnapshot).toHaveBeenCalledWith(expect.anything(), 'tenant-abc', 7);
  });

  it('requires explicit confirmation for mutating runs', async () => {
    vi.mocked(verifyAPIKey).mockReturnValue(true);

    const response = await handleFinanceAutomationAPI(
      new Request('https://example.com/api/finance/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': 'admin-key' },
        body: JSON.stringify({ dry_run: false }),
      }),
      createEnv(),
      '/api/finance/run'
    );

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.required_confirm).toBe('execute-finance-automation');
    expect(runFinanceAutomation).not.toHaveBeenCalled();
  });

  it('fails fast when autopilot auth is present but no internal admin credential is configured', async () => {
    vi.mocked(authenticateBearer).mockReturnValue({ authenticated: true, reason: 'ok' } as any);

    const response = await handleFinanceAutomationAPI(
      new Request('https://example.com/api/fugue/finance/run', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer autopilot-key',
        },
        body: JSON.stringify({ dry_run: true }),
      }),
      createEnv({ ADMIN_API_KEY: '', WORKERS_API_KEY: '' }),
      '/api/fugue/finance/run'
    );

    expect(response.status).toBe(500);
    expect(runFinanceAutomation).not.toHaveBeenCalled();
  });

  it('accepts FUGUE autopilot bearer auth and forwards privileged runtime credentials', async () => {
    vi.mocked(authenticateBearer).mockReturnValue({ authenticated: true, reason: 'ok' } as any);

    const response = await handleFinanceAutomationAPI(
      new Request('https://example.com/api/fugue/finance/run', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer autopilot-key',
        },
        body: JSON.stringify({ dry_run: true, operations: ['retry_failed'] }),
      }),
      createEnv(),
      '/api/fugue/finance/run'
    );

    expect(response.status).toBe(200);
    expect(runFinanceAutomation).toHaveBeenCalledTimes(1);
    const forwardedRequest = vi.mocked(runFinanceAutomation).mock.calls[0][0] as Request;
    expect(forwardedRequest.headers.get('authorization')).toBe('Bearer admin-key');
    const json = await response.json();
    expect(json.authMode).toBe('autopilot');
    expect(runFinanceAutomation).toHaveBeenCalledWith(
      expect.any(Request),
      expect.anything(),
      'tenant-abc',
      expect.objectContaining({ dryRun: true, operations: ['retry_failed'] })
    );
  });
});
