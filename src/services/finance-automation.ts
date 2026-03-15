import type { Env } from '../types';
import { handleReceiptAPI } from '../handlers/receipt-admin-api';
import { handleRepairHtmlReceiptText } from '../handlers/receipt-html-text-repair';
import { handleRepairFreeeLinks } from '../handlers/receipt-freee-repair';
import { handleReceiptBackfill } from '../handlers/receipt-backfill';

export const FINANCE_AUTOMATION_CONFIRM_TOKEN = 'execute-finance-automation';

export const FINANCE_OPERATION_IDS = Object.freeze([
  'poll_gmail',
  'repair_html_text',
  'retry_failed',
  'repair_freee_links',
  'backfill_receipts',
] as const);

export type FinanceOperationId = (typeof FINANCE_OPERATION_IDS)[number];

export interface FinanceAutomationRequest {
  readonly dryRun: boolean;
  readonly limit: number;
  readonly sampleLimit: number;
  readonly reclassify: boolean;
  readonly onlyMissingText: boolean;
  readonly operations?: readonly FinanceOperationId[];
}

type FinanceOverviewRow = {
  total_receipts: number;
  failed_receipts: number;
  receipts_needing_review: number;
  receipts_pending_deal: number;
  receipts_with_linked_ids: number;
  html_receipts: number;
  low_confidence_receipts: number;
  freee_not_found_candidates: number;
};

type DuplicateCountRow = {
  total_groups: number;
};

type DuplicateGroupRow = {
  vendor_name: string;
  transaction_date: string;
  amount: number;
  duplicate_count: number;
  receipt_ids: string;
};

type SampleReceiptRow = {
  id: string;
  vendor_name: string;
  transaction_date: string;
  amount: number | null;
  currency: string | null;
  status: string;
  classification_confidence: number | null;
  freee_receipt_id?: string | null;
  freee_deal_id?: string | null;
};

type TimestampRow = {
  latest_created_at: string | null;
};

export interface FinanceTriageBucket {
  readonly count: number;
  readonly samples: readonly unknown[];
}

export interface FinanceAutomationSnapshot {
  readonly generatedAt: string;
  readonly overview: {
    readonly totalReceipts: number;
    readonly failedReceipts: number;
    readonly receiptsNeedingReview: number;
    readonly receiptsPendingDeal: number;
    readonly receiptsWithLinkedIds: number;
    readonly htmlReceipts: number;
    readonly lowConfidenceReceipts: number;
    readonly freeeNotFoundCandidates: number;
    readonly latestReceiptCreatedAt: string | null;
  };
  readonly triage: {
    readonly duplicates: FinanceTriageBucket;
    readonly notFound: FinanceTriageBucket;
    readonly misclassification: FinanceTriageBucket;
  };
  readonly recommendedOperations: readonly {
    readonly id: FinanceOperationId;
    readonly reason: string;
    readonly defaultDryRun: boolean;
  }[];
  readonly recommendedPipeline: 'receipts_control_tower';
}

export interface FinanceOperationExecution {
  readonly id: FinanceOperationId;
  readonly status: 'executed' | 'dry_run' | 'failed';
  readonly responseStatus: number;
  readonly body: unknown;
}

export interface FinanceAutomationRunResult {
  readonly applied: boolean;
  readonly dryRun: boolean;
  readonly pipeline: 'receipts_control_tower';
  readonly operations: readonly FinanceOperationExecution[];
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number'
    ? value
    : Number.parseInt(String(value ?? fallback), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function normalizeOperations(request: FinanceAutomationRequest): readonly FinanceOperationId[] {
  if (request.operations && request.operations.length > 0) {
    return request.operations;
  }

  return Object.freeze([
    'poll_gmail',
    'repair_html_text',
    'retry_failed',
    'repair_freee_links',
    'backfill_receipts',
  ] as const);
}

function cloneHeaders(source: Headers): Headers {
  const headers = new Headers();
  source.forEach((value, key) => headers.set(key, value));
  return headers;
}

function buildOperationUrl(baseUrl: string, path: string, params: Record<string, string>): string {
  const url = new URL(path, baseUrl);
  Object.entries(params).forEach(([key, value]) => {
    url.searchParams.set(key, value);
  });
  return url.toString();
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function serializeBool(value: boolean): string {
  return value ? 'true' : 'false';
}

async function runPollGmail(request: Request, env: Env, dryRun: boolean): Promise<FinanceOperationExecution> {
  if (dryRun) {
    return {
      id: 'poll_gmail',
      status: 'dry_run',
      responseStatus: 200,
      body: { success: true, dry_run: true, skipped: true, reason: 'gmail polling mutates state; skipped in dry-run' },
    };
  }

  const syntheticRequest = new Request(buildOperationUrl(request.url, '/api/receipts/poll', {}), {
    method: 'POST',
    headers: cloneHeaders(request.headers),
  });
  const response = await handleReceiptAPI(syntheticRequest, env, '/api/receipts/poll');
  return {
    id: 'poll_gmail',
    status: response.ok ? 'executed' : 'failed',
    responseStatus: response.status,
    body: await readResponseBody(response),
  };
}

async function runRepairHtmlText(request: Request, env: Env, options: FinanceAutomationRequest): Promise<FinanceOperationExecution> {
  const response = await handleRepairHtmlReceiptText(new Request(
    buildOperationUrl(request.url, '/api/receipts/repair-html-text', {
      limit: String(options.limit),
      dry_run: serializeBool(options.dryRun),
      reclassify: serializeBool(options.reclassify),
      only_missing_text: serializeBool(options.onlyMissingText),
    }),
    { method: 'POST', headers: cloneHeaders(request.headers) },
  ), env);
  return {
    id: 'repair_html_text',
    status: options.dryRun ? 'dry_run' : (response.ok ? 'executed' : 'failed'),
    responseStatus: response.status,
    body: await readResponseBody(response),
  };
}

async function runRetryFailed(request: Request, env: Env, options: FinanceAutomationRequest): Promise<FinanceOperationExecution> {
  const params: Record<string, string> = { dry_run: serializeBool(options.dryRun) };
  if (!options.dryRun) params.confirm = 'execute-retry';

  const syntheticRequest = new Request(buildOperationUrl(request.url, '/api/receipts/retry', params), {
    method: 'POST',
    headers: cloneHeaders(request.headers),
  });
  const response = await handleReceiptAPI(syntheticRequest, env, '/api/receipts/retry');
  return {
    id: 'retry_failed',
    status: options.dryRun ? 'dry_run' : (response.ok ? 'executed' : 'failed'),
    responseStatus: response.status,
    body: await readResponseBody(response),
  };
}

async function runRepairFreeeLinks(
  request: Request,
  env: Env,
  tenantId: string,
  options: FinanceAutomationRequest
): Promise<FinanceOperationExecution> {
  const response = await handleRepairFreeeLinks(new Request(
    buildOperationUrl(request.url, '/api/receipts/repair-freee-links', {
      limit: String(options.limit),
      dry_run: serializeBool(options.dryRun),
    }),
    { method: 'POST', headers: cloneHeaders(request.headers) },
  ), env, tenantId);
  return {
    id: 'repair_freee_links',
    status: options.dryRun ? 'dry_run' : (response.ok ? 'executed' : 'failed'),
    responseStatus: response.status,
    body: await readResponseBody(response),
  };
}

async function runBackfillReceipts(request: Request, env: Env, options: FinanceAutomationRequest): Promise<FinanceOperationExecution> {
  const params: Record<string, string> = { dry_run: serializeBool(options.dryRun) };
  if (!options.dryRun) params.confirm = 'execute-backfill';

  const response = await handleReceiptBackfill(new Request(
    buildOperationUrl(request.url, '/api/receipts/backfill', params),
    { method: 'POST', headers: cloneHeaders(request.headers) },
  ), env);
  return {
    id: 'backfill_receipts',
    status: options.dryRun ? 'dry_run' : (response.ok ? 'executed' : 'failed'),
    responseStatus: response.status,
    body: await readResponseBody(response),
  };
}

export async function collectFinanceAutomationSnapshot(
  env: Env,
  tenantId: string,
  sampleLimit = 5
): Promise<FinanceAutomationSnapshot> {
  if (!env.DB) {
    throw new Error('D1 database not configured');
  }

  const boundedSampleLimit = clampInteger(sampleLimit, 5, 1, 20);
  const overviewRow = await env.DB.prepare(
    `SELECT
       COUNT(*) AS total_receipts,
       SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_receipts,
       SUM(CASE WHEN status = 'needs_review' THEN 1 ELSE 0 END) AS receipts_needing_review,
       SUM(CASE WHEN freee_receipt_id IS NOT NULL AND freee_deal_id IS NULL THEN 1 ELSE 0 END) AS receipts_pending_deal,
       SUM(CASE WHEN freee_receipt_id IS NOT NULL AND freee_deal_id IS NOT NULL THEN 1 ELSE 0 END) AS receipts_with_linked_ids,
       SUM(CASE WHEN source_type = 'html_body' THEN 1 ELSE 0 END) AS html_receipts,
       SUM(CASE WHEN classification_confidence IS NOT NULL AND classification_confidence < 0.85 THEN 1 ELSE 0 END) AS low_confidence_receipts,
       SUM(CASE WHEN freee_receipt_id IS NULL AND status IN ('completed', 'needs_review') THEN 1 ELSE 0 END) AS freee_not_found_candidates
     FROM receipts
     WHERE tenant_id = ?`
  ).bind(tenantId).first<FinanceOverviewRow>();

  const latestRow = await env.DB.prepare(
    'SELECT MAX(created_at) AS latest_created_at FROM receipts WHERE tenant_id = ?'
  ).bind(tenantId).first<TimestampRow>();

  const duplicateCountRow = await env.DB.prepare(
    `SELECT COUNT(*) AS total_groups FROM (
       SELECT 1
       FROM receipts
       WHERE tenant_id = ? AND vendor_name IS NOT NULL AND transaction_date IS NOT NULL AND amount IS NOT NULL AND amount > 0
       GROUP BY vendor_name, transaction_date, amount
       HAVING COUNT(*) > 1
     ) grouped`
  ).bind(tenantId).first<DuplicateCountRow>();

  const duplicateGroups = await env.DB.prepare(
    `SELECT vendor_name, transaction_date, amount, COUNT(*) AS duplicate_count, GROUP_CONCAT(id) AS receipt_ids
     FROM receipts
     WHERE tenant_id = ? AND vendor_name IS NOT NULL AND transaction_date IS NOT NULL AND amount IS NOT NULL AND amount > 0
     GROUP BY vendor_name, transaction_date, amount
     HAVING COUNT(*) > 1
     ORDER BY duplicate_count DESC, transaction_date DESC
     LIMIT ?`
  ).bind(tenantId, boundedSampleLimit).all<DuplicateGroupRow>();

  const notFoundCandidates = await env.DB.prepare(
    `SELECT id, vendor_name, transaction_date, amount, currency, status, classification_confidence
     FROM receipts
     WHERE tenant_id = ? AND freee_receipt_id IS NULL AND status IN ('completed', 'needs_review')
     ORDER BY updated_at DESC
     LIMIT ?`
  ).bind(tenantId, boundedSampleLimit).all<SampleReceiptRow>();

  const misclassificationCandidates = await env.DB.prepare(
    `SELECT id, vendor_name, transaction_date, amount, currency, status, classification_confidence, freee_receipt_id, freee_deal_id
     FROM receipts
     WHERE tenant_id = ? AND (status = 'needs_review' OR (classification_confidence IS NOT NULL AND classification_confidence < 0.85))
     ORDER BY updated_at DESC
     LIMIT ?`
  ).bind(tenantId, boundedSampleLimit).all<SampleReceiptRow>();

  const overview = {
    totalReceipts: overviewRow?.total_receipts ?? 0,
    failedReceipts: overviewRow?.failed_receipts ?? 0,
    receiptsNeedingReview: overviewRow?.receipts_needing_review ?? 0,
    receiptsPendingDeal: overviewRow?.receipts_pending_deal ?? 0,
    receiptsWithLinkedIds: overviewRow?.receipts_with_linked_ids ?? 0,
    htmlReceipts: overviewRow?.html_receipts ?? 0,
    lowConfidenceReceipts: overviewRow?.low_confidence_receipts ?? 0,
    freeeNotFoundCandidates: overviewRow?.freee_not_found_candidates ?? 0,
    latestReceiptCreatedAt: latestRow?.latest_created_at ?? null,
  };

  const recommendedOperations: Array<{ id: FinanceOperationId; reason: string; defaultDryRun: boolean }> = [];
  if (overview.htmlReceipts > 0) {
    recommendedOperations.push({
      id: 'repair_html_text',
      reason: 'Normalize HTML receipts into durable text evidence before bookkeeping.',
      defaultDryRun: true,
    });
  }
  if (overview.failedReceipts > 0) {
    recommendedOperations.push({
      id: 'retry_failed',
      reason: 'Retry failed freee uploads to clear ingestion backlog.',
      defaultDryRun: true,
    });
  }
  if (overview.receiptsWithLinkedIds > 0) {
    recommendedOperations.push({
      id: 'repair_freee_links',
      reason: 'Audit drift between freee receipts and linked deals.',
      defaultDryRun: true,
    });
  }
  if (overview.receiptsPendingDeal > 0) {
    recommendedOperations.push({
      id: 'backfill_receipts',
      reason: 'Create missing deals for receipts already uploaded to freee.',
      defaultDryRun: true,
    });
  }
  recommendedOperations.push({
    id: 'poll_gmail',
    reason: 'Pull the next Gmail batch so finance intake remains end-to-end automated.',
    defaultDryRun: false,
  });

  return {
    generatedAt: new Date().toISOString(),
    overview,
    triage: {
      duplicates: {
        count: duplicateCountRow?.total_groups ?? 0,
        samples: (duplicateGroups.results ?? []).map((row) => ({
          vendorName: row.vendor_name,
          transactionDate: row.transaction_date,
          amount: row.amount,
          duplicateCount: row.duplicate_count,
          receiptIds: row.receipt_ids?.split(',') ?? [],
        })),
      },
      notFound: {
        count: overview.freeeNotFoundCandidates,
        samples: notFoundCandidates.results ?? [],
      },
      misclassification: {
        count: Math.max(overview.lowConfidenceReceipts, misclassificationCandidates.results?.length ?? 0),
        samples: misclassificationCandidates.results ?? [],
      },
    },
    recommendedOperations,
    recommendedPipeline: 'receipts_control_tower',
  };
}

export async function runFinanceAutomation(
  request: Request,
  env: Env,
  _tenantId: string,
  rawRequest: Partial<FinanceAutomationRequest>,
): Promise<FinanceAutomationRunResult> {
  const normalizedRequest: FinanceAutomationRequest = {
    dryRun: rawRequest.dryRun ?? true,
    limit: clampInteger(rawRequest.limit, 20, 1, 100),
    sampleLimit: clampInteger(rawRequest.sampleLimit, 5, 1, 20),
    reclassify: rawRequest.reclassify ?? true,
    onlyMissingText: rawRequest.onlyMissingText ?? true,
    operations: rawRequest.operations,
  };

  const operations = normalizeOperations(normalizedRequest);
  const results: FinanceOperationExecution[] = [];

  for (const operation of operations) {
    switch (operation) {
      case 'poll_gmail':
        results.push(await runPollGmail(request, env, normalizedRequest.dryRun));
        break;
      case 'repair_html_text':
        results.push(await runRepairHtmlText(request, env, normalizedRequest));
        break;
      case 'retry_failed':
        results.push(await runRetryFailed(request, env, normalizedRequest));
        break;
      case 'repair_freee_links':
        results.push(await runRepairFreeeLinks(request, env, _tenantId, normalizedRequest));
        break;
      case 'backfill_receipts':
        results.push(await runBackfillReceipts(request, env, normalizedRequest));
        break;
    }
  }

  return {
    applied: !normalizedRequest.dryRun,
    dryRun: normalizedRequest.dryRun,
    pipeline: 'receipts_control_tower',
    operations: results,
  };
}
