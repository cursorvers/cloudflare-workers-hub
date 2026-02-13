/**
 * Receipt Poller Utilities
 *
 * Shared constants and helper functions used by both
 * the PDF and HTML receipt processing pipelines.
 */

import type { Env } from '../types';
import { RATE_LIMITS } from '../config/confidence-thresholds';

// ── Constants ────────────────────────────────────────────────────────
export const RETENTION_YEARS = 7;
export const DEFAULT_TENANT_ID = 'default';
export const MAX_RESULTS = RATE_LIMITS.MAX_RESULTS;
export const MAX_DEALS_PER_RUN = RATE_LIMITS.MAX_DEALS_PER_RUN;

// ── Bucket helper ────────────────────────────────────────────────────
export function getReceiptBucket(env: Env): R2Bucket | null {
  return env.RECEIPTS ?? env.R2 ?? null;
}

// ── Date helpers ─────────────────────────────────────────────────────
export function addYears(date: Date, years: number): string {
  const next = new Date(date);
  next.setFullYear(next.getFullYear() + years);
  return next.toISOString().slice(0, 10);
}

export function toIsoDate(date: Date | undefined): string {
  if (!date || Number.isNaN(date.getTime())) {
    return new Date().toISOString().slice(0, 10);
  }
  return date.toISOString().slice(0, 10);
}

// ── Hashing ──────────────────────────────────────────────────────────
export async function calculateSha256(data: ArrayBuffer | ArrayBufferView): Promise<string> {
  const bytes = data instanceof ArrayBuffer
    ? new Uint8Array(data)
    : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);

  // Ensure we hand SubtleCrypto a concrete ArrayBuffer (not SharedArrayBuffer).
  const buf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);

  const hashBuffer = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ── Vendor normalization ─────────────────────────────────────────────

/**
 * Parse RFC 2822 From header to extract display name.
 * "Billing <billing@cloudflare.com>" → "Billing"
 * "billing@cloudflare.com" → "cloudflare.com"
 * "<billing@cloudflare.com>" → "cloudflare.com"
 */
export function normalizeVendorFromEmail(rawFrom: string): string {
  const trimmed = rawFrom.trim();

  // "Display Name <email@domain>" format
  const angleMatch = trimmed.match(/^(.+?)\s*<[^>]+>$/);
  if (angleMatch) {
    const displayName = angleMatch[1].replace(/^["']|["']$/g, '').trim();
    if (displayName.length > 0) {
      return displayName;
    }
  }

  // "<email@domain>" or "email@domain" — extract domain
  const emailMatch = trimmed.match(/@([a-zA-Z0-9.-]+)/);
  if (emailMatch) {
    const domain = emailMatch[1];
    // Strip common TLDs to get company name: "cloudflare.com" → "cloudflare"
    const parts = domain.split('.');
    if (parts.length >= 2) {
      return parts.slice(0, -1).join('.');
    }
    return domain;
  }

  return trimmed || 'Unknown';
}

export function isEmailLikeVendor(vendor: string): boolean {
  return /@/.test(vendor) || /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(vendor);
}

// ── D1 helpers ───────────────────────────────────────────────────────
export async function hasDuplicateHash(env: Env, fileHash: string): Promise<string | null> {
  const existing = await env.DB!.prepare(
    'SELECT id FROM receipts WHERE file_hash = ? LIMIT 1'
  )
    .bind(fileHash)
    .first<{ id: string }>();

  return existing?.id ?? null;
}

// ── Accounting content validation ────────────────────────────────────
// Only upload to freee if the document contains actual accounting content.
// Checks for: monetary amounts, accounting keywords, or known billing subjects.

const ACCOUNTING_KEYWORDS_JA = [
  '領収', '領収書', '領収証',
  '請求', '請求書', 'ご請求',
  '明細', '利用明細', 'ご利用明細',
  '納品書', '見積書',
  '合計', '小計', '税込', '税抜',
  '振込', '引き落とし', '決済',
  'お支払い', '支払い',
  'ご入金', '課税', '非課税',
] as const;

const ACCOUNTING_KEYWORDS_EN = [
  'receipt', 'invoice', 'tax invoice',
  'billing', 'billing statement', 'payment receipt',
  'payment', 'payment confirmation',
  'total', 'subtotal', 'amount due',
  'paid', 'charge', 'transaction',
  'fee', 'bill', 'cost',
  'order confirmation', 'subscription',
  'statement',
] as const;

const AMOUNT_PATTERNS = [
  /[¥￥]\s*[\d,]+/,        // ¥1,234 or ￥1,234
  /[\d,]+\s*円/,            // 1,234円
  /JPY\s*[\d,]+/i,         // JPY 1234
  /\$\s*[\d,.]+/,           // $12.34
  /USD\s*[\d,.]+/i,         // USD 12.34
  /(?:合計|total|amount)[:\s]*[\d,]+/i,
] as const;

/**
 * Check if text contains accounting-related content (monetary amounts or financial keywords).
 * Returns { pass: true } if content appears to be a receipt/invoice,
 * or { pass: false, reason } if not.
 */
export function hasAccountingContent(
  text: string,
  subject?: string
): { pass: boolean; reason?: string } {
  const combined = `${subject ?? ''}\n${text}`.toLowerCase();

  // Check for monetary amount patterns (strongest signal)
  for (const pattern of AMOUNT_PATTERNS) {
    if (pattern.test(combined)) {
      return { pass: true };
    }
  }

  // Check for Japanese accounting keywords
  for (const keyword of ACCOUNTING_KEYWORDS_JA) {
    if (combined.includes(keyword)) {
      return { pass: true };
    }
  }

  // Check for English accounting keywords
  for (const keyword of ACCOUNTING_KEYWORDS_EN) {
    if (combined.includes(keyword)) {
      return { pass: true };
    }
  }

  return {
    pass: false,
    reason: 'No monetary amounts or accounting keywords found in document text',
  };
}

// ── File name helpers ────────────────────────────────────────────────
export function normalizeFileName(fileName: string, fallback: string): string {
  const cleaned = fileName.replace(/[\\/]/g, '_').replace(/[^a-zA-Z0-9._-]/g, '_');
  return cleaned.length > 0 ? cleaned : fallback;
}
