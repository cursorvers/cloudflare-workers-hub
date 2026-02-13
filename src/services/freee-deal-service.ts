/**
 * freee Deal Service
 *
 * Creates deals from receipts and links them to freee receipts.
 */

import type { Env } from '../types';
import { safeLog } from '../utils/log-sanitizer';
import { createFreeeClient } from './freee-client';
import type { FreeeAccountItem, FreeePartner, FreeeTax } from './freee-master-cache';
import {
  createPartner,
  findPartnerByName,
  getAccountItems,
  getTaxes,
} from './freee-master-cache';
import { selectAccountItemForReceipt } from './freee-account-selector';
import { CONFIDENCE, AMOUNT, decideDealStatus } from '../config/confidence-thresholds';

// =============================================================================
// Types
// =============================================================================

type DealStatus = 'created' | 'needs_review';

export interface DealCreateParams {
  company_id: number;
  issue_date: string;
  type: 'expense';
  partner_id?: number;
  details: Array<{
    account_item_id: number;
    tax_code: number;
    amount: number;
    description?: string;
  }>;
}

export interface DealResult {
  dealId: number | null;
  partnerId: number | null;
  mappingConfidence: number;
  status: DealStatus;
  accountItemId?: number | null;
  taxCode?: number | null;
  mappingMethod?: string | null;
  selectionProvider?: string | null;
}

export interface ReceiptInput {
  id: string;
  freee_receipt_id?: string | number | null;
  file_hash?: string | null;
  vendor_name: string;
  amount: number;
  currency?: string | null;
  transaction_date: string;
  account_category?: string | null;
  classification_confidence?: number | null;
  confidence?: number | null;
  tenant_id?: string;
}

interface DealApiResponse {
  deal: {
    id: number;
  };
}

interface ReceiptLinkResponse {
  receipt: {
    id: number;
    deal_id?: number;
  };
}

interface ExistingDealRecord {
  deal_id: number;
  partner_id: number | null;
  mapping_confidence: number;
  status: DealStatus;
}

interface DealLinkInsert {
  receiptId: string;
  dealId: number;
  partnerId: number | null;
  mappingConfidence: number;
  status: DealStatus;
  idempotencyKey: string;
  freeeReceiptId?: string | number | null;
}

interface RequestCapableFreeeClient {
  request<T>(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    body?: unknown,
    idempotencyKey?: string
  ): Promise<T>;
}

interface AccessTokenProvider {
  getAccessTokenPublic: () => Promise<string>;
}

interface CompanyIdProvider {
  getCompanyId: () => Promise<string>;
}

// =============================================================================
// Helpers
// =============================================================================

function toNumber(value: string | undefined): number {
  const parsed = value ? Number.parseInt(value, 10) : Number.NaN;
  if (!Number.isFinite(parsed)) {
    throw new Error('freee company_id is required');
  }
  return parsed;
}

function clampConfidence(value: number | null | undefined): number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

function isValidPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function buildIdempotencyKey(receipt: ReceiptInput): string {
  const key = receipt.file_hash ?? receipt.id;
  if (!key) {
    throw new Error('Receipt idempotency key is required');
  }
  const tenantPrefix = receipt.tenant_id ?? 'default';
  return `${tenantPrefix}:${key}`;
}

function resolveClassificationConfidence(receipt: ReceiptInput): number {
  return clampConfidence(
    receipt.classification_confidence ?? receipt.confidence ?? 0
  );
}

async function resolveAccessToken(
  client: RequestCapableFreeeClient
): Promise<string> {
  const provider = client as unknown as AccessTokenProvider;
  if (typeof provider.getAccessTokenPublic !== 'function') {
    throw new Error('FreeeClient.getAccessTokenPublic() is required for master cache');
  }
  return provider.getAccessTokenPublic();
}

async function getExistingDeal(
  env: Env,
  receiptId: string
): Promise<ExistingDealRecord | null> {
  if (!env.DB) {
    throw new Error('D1 database binding is required');
  }

  const record = await env.DB.prepare(
    'SELECT deal_id, partner_id, mapping_confidence, status FROM receipt_deals WHERE receipt_id = ?'
  )
    .bind(receiptId)
    .first<ExistingDealRecord>();

  return record ?? null;
}

async function recordDealLink(
  env: Env,
  insert: DealLinkInsert
): Promise<void> {
  if (!env.DB) {
    throw new Error('D1 database binding is required');
  }

  await env.DB.prepare(
    `INSERT INTO receipt_deals
      (receipt_id, deal_id, partner_id, mapping_confidence, status, idempotency_key, freee_receipt_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`
  )
    .bind(
      insert.receiptId,
      insert.dealId,
      insert.partnerId,
      insert.mappingConfidence,
      insert.status,
      insert.idempotencyKey,
      insert.freeeReceiptId ?? null
    )
    .run();
}

function decideStatus(confidence: number, amount: number, scoreGap: number): DealStatus {
  const result = decideDealStatus(confidence, amount, scoreGap);
  // 'skip' should not reach here (caller handles it), but fallback to needs_review
  return result === 'skip' ? 'needs_review' : result;
}

function logConfidence(env: Env, confidence: number, receipt: ReceiptInput): void {
  if (confidence >= 0.9) {
    return;
  }

  const level = confidence >= 0.7 ? 'warn' : 'info';
  safeLog(env, level, '[FreeeDealService] confidence below auto threshold', {
    receiptId: receipt.id,
    confidence,
  });
}

async function resolvePartner(
  env: Env,
  accessToken: string,
  vendorName: string
): Promise<FreeePartner> {
  const existing = await findPartnerByName(env, accessToken, vendorName);
  if (existing) {
    return existing;
  }
  return createPartner(env, accessToken, vendorName);
}

// =============================================================================
// Public API
// =============================================================================

export async function createDealFromReceipt(
  env: Env,
  receipt: ReceiptInput
): Promise<DealResult> {
  const idempotencyKey = buildIdempotencyKey(receipt);

  const currency = (receipt.currency ?? 'JPY').toString().trim().toUpperCase();
  if (currency && currency !== 'JPY') {
    safeLog(env, 'warn', '[FreeeDealService] skipping deal: non-JPY currency (manual review required)', {
      receiptId: receipt.id,
      vendorName: receipt.vendor_name,
      amount: receipt.amount,
      currency,
    });
    return {
      dealId: null,
      partnerId: null,
      mappingConfidence: 0,
      status: 'needs_review',
      accountItemId: null,
      taxCode: null,
      mappingMethod: null,
      selectionProvider: null,
    };
  }

  // Guard: amount must be positive to create a freee deal.
  // Zero-amount receipts indicate extraction failure (e.g., R2 missing) — skip deal creation.
  if (receipt.amount <= 0) {
    safeLog(env, 'warn', '[FreeeDealService] skipping deal: amount <= 0 (extraction failure)', {
      receiptId: receipt.id,
      vendorName: receipt.vendor_name,
      amount: receipt.amount,
    });
    return {
      dealId: null,
      partnerId: null,
      mappingConfidence: 0,
      status: 'needs_review',
      accountItemId: null,
      taxCode: null,
      mappingMethod: null,
      selectionProvider: null,
    };
  }

  const existing = await getExistingDeal(env, receipt.id);
  if (existing) {
    return {
      dealId: existing.deal_id,
      partnerId: existing.partner_id ?? null,
      mappingConfidence: existing.mapping_confidence,
      status: existing.status,
      accountItemId: null,
      taxCode: null,
      mappingMethod: null,
      selectionProvider: null,
    };
  }

  const freeeClient = createFreeeClient(env) as unknown as RequestCapableFreeeClient;
  const companyIdStr = await (freeeClient as unknown as CompanyIdProvider).getCompanyId();
  const companyId = toNumber(companyIdStr);
  const accessToken = await resolveAccessToken(freeeClient);
  const envForCache = { ...env, FREEE_COMPANY_ID: companyIdStr };

  const [accountItems, taxes] = await Promise.all([
    getAccountItems(envForCache, accessToken),
    getTaxes(envForCache, accessToken),
  ]);

  const selection = await selectAccountItemForReceipt(
    env,
    {
      vendor_name: receipt.vendor_name,
      amount: receipt.amount,
      transaction_date: receipt.transaction_date,
      account_category: receipt.account_category ?? null,
      tenant_id: receipt.tenant_id,
      // tax_type is stored on receipts in D1, but not always provided here (optional).
      tax_type: null,
    },
    accountItems as readonly FreeeAccountItem[],
    taxes as readonly FreeeTax[]
  );

  // Fail-closed: if the selector returns invalid IDs, do not attempt freee mutations.
  const selectedAccountItemId = isValidPositiveInt(selection.accountItemId)
    ? selection.accountItemId
    : null;
  const selectedTaxCode = isValidPositiveInt(selection.taxCode)
    ? selection.taxCode
    : null;
  if (!selectedAccountItemId || !selectedTaxCode) {
    safeLog(env, 'warn', '[FreeeDealService] invalid account/tax selection (needs review)', {
      receiptId: receipt.id,
      accountItemId: selection.accountItemId,
      taxCode: selection.taxCode,
      provider: selection.provider,
    });
    return {
      dealId: null,
      partnerId: null,
      mappingConfidence: 0,
      status: 'needs_review',
      accountItemId: selectedAccountItemId,
      taxCode: selectedTaxCode,
      mappingMethod: selection.mappingMethod,
      selectionProvider: selection.provider,
    };
  }

  const classificationConfidence = resolveClassificationConfidence(receipt);
  const mappingConfidence = clampConfidence(selection.mappingConfidence);
  // Weighted average (mapping 70%, classification 30%) instead of Math.min.
  // Rationale: mapping confidence is the direct signal (did we pick the right account?).
  // Classification confidence is indirect (AI labeling of the receipt image).
  // Using Math.min killed automation rate because one low score vetoed everything.
  const overallConfidence = mappingConfidence * 0.7 + classificationConfidence * 0.3;
  logConfidence(env, overallConfidence, receipt);

  // Two-threshold system (3-party consensus 2026-02-09):
  // - MIN_CREATE (0.25): create deal as needs_review
  // - MIN_AUTO (0.50): auto-confirm deal as created
  // - MIN_AUTO_HIGH_AMOUNT (0.70): high-value safety gate
  const dealDecision = decideDealStatus(overallConfidence, receipt.amount, selection.scoreGap);

  if (dealDecision === 'skip') {
    return {
      dealId: null,
      partnerId: null,
      mappingConfidence,
      status: 'needs_review',
      accountItemId: selection.accountItemId,
      taxCode: selection.taxCode,
      mappingMethod: selection.mappingMethod,
      selectionProvider: selection.provider,
    };
  }

  const partnerName = receipt.vendor_name.trim() || 'Unknown';
  const partner = await resolvePartner(env, accessToken, partnerName);

  const dealPayload: DealCreateParams = {
    company_id: companyId,
    issue_date: receipt.transaction_date,
    type: 'expense',
    partner_id: partner.id,
    details: [
      {
        account_item_id: selectedAccountItemId,
        tax_code: selectedTaxCode,
        amount: receipt.amount,
        description: partner.name,
      },
    ],
  };

  const dealResponse = await freeeClient.request<DealApiResponse>(
    'POST',
    '/deals',
    dealPayload,
    idempotencyKey
  );

  const dealId = dealResponse.deal.id;

  if (!receipt.freee_receipt_id) {
    throw new Error('freee receipt id is required to link deals');
  }

  await freeeClient.request<ReceiptLinkResponse>(
    'PUT',
    `/receipts/${receipt.freee_receipt_id}`,
    {
      company_id: companyId,
      deal_id: dealId,
    },
    idempotencyKey
  );

  const status = decideStatus(overallConfidence, receipt.amount, selection.scoreGap);

  await recordDealLink(env, {
    receiptId: receipt.id,
    dealId,
    partnerId: partner.id,
    mappingConfidence: clampConfidence(mappingConfidence),
    status,
    idempotencyKey,
    freeeReceiptId: receipt.freee_receipt_id,
  });

  return {
    dealId,
    partnerId: partner.id,
    mappingConfidence,
    status,
    accountItemId: selectedAccountItemId,
    taxCode: selectedTaxCode,
    mappingMethod: selection.mappingMethod,
    selectionProvider: selection.provider,
  };
}
