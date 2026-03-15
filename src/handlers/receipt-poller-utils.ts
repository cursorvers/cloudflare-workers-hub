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
    'SELECT id FROM receipts WHERE tenant_id = ? AND file_hash = ? LIMIT 1'
  )
    .bind(DEFAULT_TENANT_ID, fileHash)
    .first<{ id: string }>();

  return existing?.id ?? null;
}

export async function hasDuplicateHashForTenant(
  env: Env,
  tenantId: string,
  fileHash: string
): Promise<string | null> {
  const existing = await env.DB!.prepare(
    'SELECT id FROM receipts WHERE tenant_id = ? AND file_hash = ? LIMIT 1'
  )
    .bind(tenantId, fileHash)
    .first<{ id: string }>();

  return existing?.id ?? null;
}

export async function resolveOperationalTenantId(env: Env): Promise<string> {
  if (!env.DB) {
    throw new Error('DB not configured');
  }

  const configured = (env as Env & { RECEIPT_OPERATIONAL_TENANT_ID?: string }).RECEIPT_OPERATIONAL_TENANT_ID?.trim();
  if (configured) {
    const row = await env.DB.prepare(
      'SELECT tenant_id FROM tenant_users WHERE tenant_id = ? AND is_active = 1 LIMIT 1'
    )
      .bind(configured)
      .first<{ tenant_id: string }>();
    if (!row) {
      throw new Error(`Configured operational tenant ${configured} is not active`);
    }
    return configured;
  }

  const rows = await env.DB.prepare(
    `SELECT tenant_id
     FROM tenant_users
     WHERE is_active = 1
     GROUP BY tenant_id
     ORDER BY tenant_id ASC
     LIMIT 2`
  ).all<{ tenant_id: string }>();

  const results = rows.results ?? [];
  if (results.length === 0) {
    throw new Error('No active tenant found for scheduled receipt operations');
  }

  if (results.length > 1) {
    throw new Error('Multiple active tenants found; RECEIPT_OPERATIONAL_TENANT_ID is required');
  }

  return results[0].tenant_id;
}

// ── File name helpers ────────────────────────────────────────────────
export function normalizeFileName(fileName: string, fallback: string): string {
  const cleaned = fileName.replace(/[\\/]/g, '_').replace(/[^a-zA-Z0-9._-]/g, '_');
  return cleaned.length > 0 ? cleaned : fallback;
}
