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
  receipt_ids?: number[];
  details: Array<{
    id?: number;
    account_item_id: number;
    tax_code: number;
    amount: number;
    item_id?: number;
    section_id?: number;
    tag_ids?: number[];
    segment_1_tag_id?: number;
    segment_2_tag_id?: number;
    segment_3_tag_id?: number;
    description?: string;
    vat?: number;
  }>;
  due_date?: string;
  partner_code?: string;
  ref_number?: string;
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
  // When true and an existing deal is found, retry receipt↔deal linking only.
  retry_link_if_existing?: boolean;
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
    issue_date?: string;
    type?: 'income' | 'expense';
    partner_id?: number;
    partner_code?: string;
    ref_number?: string;
    due_date?: string;
    details?: Array<{
      id?: number;
      account_item_id: number;
      tax_code: number;
      amount: number;
      item_id?: number;
      section_id?: number;
      tag_ids?: number[];
      segment_1_tag_id?: number;
      segment_2_tag_id?: number;
      segment_3_tag_id?: number;
      description?: string;
      vat?: number;
    }>;
    receipts?: Array<{ id: number }>;
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

function normalizeFreeeReceiptId(value: string | number | null | undefined): string | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? String(value) : null;
  }
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
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
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(receipt_id) DO UPDATE SET
       deal_id = excluded.deal_id,
       partner_id = excluded.partner_id,
       mapping_confidence = excluded.mapping_confidence,
       status = excluded.status,
       idempotency_key = excluded.idempotency_key,
       freee_receipt_id = COALESCE(excluded.freee_receipt_id, receipt_deals.freee_receipt_id)`
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

async function linkReceiptToDeal(
  freeeClient: RequestCapableFreeeClient,
  companyId: number,
  freeeReceiptId: number,
  dealId: number,
  idempotencyKey: string
): Promise<void> {
  const existingDeal = await freeeClient.request<DealApiResponse>(
    'GET',
    `/deals/${dealId}?company_id=${companyId}`
  );
  const deal = existingDeal.deal;

  const existingReceiptIds = Array.isArray(deal.receipts)
    ? deal.receipts
      .map((r) => (typeof r?.id === 'number' ? r.id : Number.NaN))
      .filter((id) => Number.isFinite(id) && id > 0)
    : [];

  if (existingReceiptIds.includes(freeeReceiptId)) {
    return;
  }

  const details = Array.isArray(deal.details) ? deal.details : [];
  if (details.length === 0) {
    throw new Error('deal details are required to update receipt links');
  }

  const updatePayload: DealCreateParams = {
    company_id: companyId,
    issue_date: deal.issue_date ?? new Date().toISOString().slice(0, 10),
    type: deal.type === 'income' ? 'expense' : 'expense',
    details: details.map((d) => {
      const out: DealCreateParams['details'][number] = {
        id: d.id,
        account_item_id: d.account_item_id,
        tax_code: d.tax_code,
        amount: d.amount,
      };
      if (typeof d.item_id === 'number') out.item_id = d.item_id;
      if (typeof d.section_id === 'number') out.section_id = d.section_id;
      if (Array.isArray(d.tag_ids) && d.tag_ids.length > 0) out.tag_ids = d.tag_ids;
      if (typeof d.segment_1_tag_id === 'number') out.segment_1_tag_id = d.segment_1_tag_id;
      if (typeof d.segment_2_tag_id === 'number') out.segment_2_tag_id = d.segment_2_tag_id;
      if (typeof d.segment_3_tag_id === 'number') out.segment_3_tag_id = d.segment_3_tag_id;
      if (typeof d.description === 'string') out.description = d.description;
      if (typeof d.vat === 'number') out.vat = d.vat;
      return out;
    }),
    receipt_ids: Array.from(new Set([...existingReceiptIds, freeeReceiptId])),
  };

  if (typeof deal.partner_id === 'number') {
    updatePayload.partner_id = deal.partner_id;
  }
  if (typeof deal.partner_code === 'string') {
    updatePayload.partner_code = deal.partner_code;
  }
  if (typeof deal.ref_number === 'string') {
    updatePayload.ref_number = deal.ref_number;
  }
  if (typeof deal.due_date === 'string') {
    updatePayload.due_date = deal.due_date;
  }

  await freeeClient.request<DealApiResponse>(
    'PUT',
    `/deals/${dealId}`,
    updatePayload,
    idempotencyKey
  );
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
  const freeeReceiptId = normalizeFreeeReceiptId(receipt.freee_receipt_id);
  if (!freeeReceiptId) {
    throw new Error('freee receipt id is required to link deals');
  }
  const freeeReceiptIdNum = Number.parseInt(freeeReceiptId, 10);
  if (!Number.isFinite(freeeReceiptIdNum) || freeeReceiptIdNum <= 0) {
    throw new Error('freee receipt id must be a positive integer');
  }

  const existing = await getExistingDeal(env, receipt.id);
  if (existing) {
    if (receipt.retry_link_if_existing) {
      const freeeReceiptId = normalizeFreeeReceiptId(receipt.freee_receipt_id);
      if (!freeeReceiptId) {
        throw new Error('freee receipt id is required to retry existing deal link');
      }

      const retryClient = createFreeeClient(env) as unknown as RequestCapableFreeeClient;
      const retryCompanyIdStr = await (retryClient as unknown as CompanyIdProvider).getCompanyId();
      const retryCompanyId = toNumber(retryCompanyIdStr);

      await linkReceiptToDeal(
        retryClient,
        retryCompanyId,
        freeeReceiptIdNum,
        existing.deal_id,
        idempotencyKey
      );

      await recordDealLink(env, {
        receiptId: receipt.id,
        dealId: existing.deal_id,
        partnerId: existing.partner_id ?? null,
        mappingConfidence: clampConfidence(existing.mapping_confidence),
        status: existing.status,
        idempotencyKey,
        freeeReceiptId,
      });
    }

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

  const currency = typeof receipt.currency === 'string' && receipt.currency.trim()
    ? receipt.currency.trim().toUpperCase()
    : 'JPY';
  if (currency !== 'JPY') {
    safeLog(env, 'warn', '[FreeeDealService] non-JPY receipt: skipping deal creation (needs review)', {
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

  // Amount=0: do NOT create a deal.
  // freee Deal API rejects 0 amount lines (400). Keep the receipt in File Box and
  // mark as needs_review so a human can fix the amount/category first.
  if (receipt.amount <= 0) {
    safeLog(env, 'warn', '[FreeeDealService] amount <= 0, skipping deal creation (needs review)', {
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
  let status = decideStatus(overallConfidence, receipt.amount, selection.scoreGap);

  // Persist deal mapping BEFORE receipt-link API call to avoid duplicate deal creation on retry.
  await recordDealLink(env, {
    receiptId: receipt.id,
    dealId,
    partnerId: partner.id,
    mappingConfidence: clampConfidence(mappingConfidence),
    status,
    idempotencyKey,
    freeeReceiptId,
  });

  // Best-effort: attach receipt to deal. If this fails, we still keep the mapping and
  // return needs_review so a retry job/manual action can fix the linkage.
  try {
    await linkReceiptToDeal(
      freeeClient,
      companyId,
      freeeReceiptIdNum,
      dealId,
      idempotencyKey
    );
  } catch (linkError) {
    status = 'needs_review';
    safeLog(env, 'warn', '[FreeeDealService] deal created but receipt link failed (needs review)', {
      receiptId: receipt.id,
      dealId,
      error: linkError instanceof Error ? linkError.message : String(linkError),
    });
  }

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
