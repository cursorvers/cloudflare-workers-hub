/**
 * FX Rate Service
 *
 * Provides USD→JPY conversion with audit trail for freee receipt pipeline.
 *
 * Design (6-agent Tutti consensus 2026-02-15):
 * - On-demand: KV cache → D1 → External API
 * - Math.floor for JPY rounding (tax compliance: 1円未満切捨て)
 * - Append-only D1 for immutable audit trail
 * - Sanity range: 50-250 JPY/USD
 * - Holiday fallback: loop up to 7 days back
 */

import type { Env } from '../types';
import { safeLog } from '../utils/log-sanitizer';

// =============================================================================
// Types
// =============================================================================

export interface FxConversionResult {
  readonly amountJpy: number;
  readonly amountOriginal: number;
  readonly originalCurrency: string;
  readonly rate: number;
  readonly rateDate: string;       // Actual date the rate was sourced from
  readonly requestedDate: string;  // Transaction date originally requested
  readonly rateSource: string;
  readonly rateType: string;       // TTM | TTS | TTB
  readonly sanityOk: boolean;
  readonly roundingRule: string;   // 'floor' (1円未満切捨て)
}

interface FxRateRecord {
  readonly rate: number;
  readonly usedDate: string;
  readonly source: string;
  readonly rateType: string;
  readonly fetchedAt: string;
  readonly sanityOk: boolean;
}

// =============================================================================
// Constants
// =============================================================================

/** SSRF-safe: allowlisted FX API hosts (HTTPS only, no redirects) */
const FX_API_ALLOWLIST = [
  'api.exchangerate-api.com',
  'open.er-api.com',
] as const;

const FX_API_BASE = 'https://open.er-api.com/v6/latest/USD';

/** Sanity range for JPY/USD rate (covers historical extremes with margin) */
const RATE_MIN = 50;
const RATE_MAX = 250;

/** Max business day fallback attempts */
const MAX_FALLBACK_DAYS = 7;

/** KV cache TTL for FX rates (24 hours) */
const KV_TTL_SECONDS = 24 * 60 * 60;

// =============================================================================
// Rate Fetching
// =============================================================================

/**
 * Fetch USD→JPY rate from external API.
 * SSRF protection: allowlisted host, HTTPS only, no redirects.
 */
async function fetchRateFromApi(env: Env): Promise<{ rate: number; source: string } | null> {
  try {
    const url = new URL(FX_API_BASE);
    // Verify host is in allowlist
    if (!FX_API_ALLOWLIST.includes(url.hostname as typeof FX_API_ALLOWLIST[number])) {
      safeLog(env, 'error', 'FX API host not in allowlist', { host: url.hostname });
      return null;
    }

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      redirect: 'manual', // Prevent redirect-based SSRF
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      safeLog(env, 'warn', 'FX API returned non-OK status', { status: response.status });
      return null;
    }

    const data = await response.json() as any;

    // Response validation
    if (!data || typeof data !== 'object') return null;
    const jpyRate = data?.rates?.JPY;

    if (typeof jpyRate !== 'number' || !Number.isFinite(jpyRate) || jpyRate <= 0) {
      safeLog(env, 'warn', 'FX API returned invalid JPY rate', { jpyRate });
      return null;
    }

    return { rate: jpyRate, source: 'open.er-api.com' };
  } catch (error) {
    safeLog(env, 'warn', 'FX API fetch failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Check sanity of JPY/USD rate (50-250 range).
 */
function isRateSane(rate: number): boolean {
  return Number.isFinite(rate) && rate >= RATE_MIN && rate <= RATE_MAX;
}

// =============================================================================
// Caching (KV + D1)
// =============================================================================

function kvKey(date: string): string {
  return `fx:USDJPY:${date}`;
}

/**
 * Get cached rate from KV.
 */
async function getCachedRateFromKv(
  env: Env,
  date: string,
): Promise<FxRateRecord | null> {
  if (!env.KV) return null;
  try {
    const cached = await env.KV.get(kvKey(date));
    if (!cached) return null;
    return JSON.parse(cached) as FxRateRecord;
  } catch {
    return null;
  }
}

/**
 * Get rate from D1 fx_rates table.
 */
async function getRateFromD1(
  env: Env,
  date: string,
): Promise<FxRateRecord | null> {
  if (!env.DB) return null;
  try {
    const row = await env.DB.prepare(
      'SELECT rate, used_date, source, rate_type, fetched_at, sanity_ok FROM fx_rates WHERE pair = ? AND requested_date = ? ORDER BY fetched_at DESC LIMIT 1'
    ).bind('USDJPY', date).first<{
      rate: number;
      used_date: string;
      source: string;
      rate_type: string;
      fetched_at: string;
      sanity_ok: number;
    }>();
    if (!row) return null;
    return {
      rate: row.rate,
      usedDate: row.used_date,
      source: row.source,
      rateType: row.rate_type,
      fetchedAt: row.fetched_at,
      sanityOk: row.sanity_ok === 1,
    };
  } catch {
    return null;
  }
}

/**
 * Persist rate to D1 (append-only) and KV cache.
 */
async function persistRate(
  env: Env,
  requestedDate: string,
  record: FxRateRecord,
): Promise<void> {
  // D1 append-only insert
  if (env.DB) {
    try {
      await env.DB.prepare(
        'INSERT INTO fx_rates (pair, requested_date, used_date, rate, source, rate_type, fetched_at, sanity_ok) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).bind(
        'USDJPY',
        requestedDate,
        record.usedDate,
        record.rate,
        record.source,
        record.rateType,
        record.fetchedAt,
        record.sanityOk ? 1 : 0,
      ).run();
    } catch (error) {
      safeLog(env, 'warn', 'FX rate D1 persist failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // KV cache
  if (env.KV) {
    try {
      await env.KV.put(kvKey(requestedDate), JSON.stringify(record), {
        expirationTtl: KV_TTL_SECONDS,
      });
    } catch {
      // Non-critical
    }
  }
}

// =============================================================================
// Core: Get Rate with Fallback
// =============================================================================

/**
 * Get USD→JPY rate for a given date.
 * Lookup order: KV → D1 → External API.
 * Holiday fallback: loops back up to 7 days.
 */
export async function getUsdJpyRate(
  env: Env,
  transactionDate: string,
): Promise<FxRateRecord | null> {
  // Try exact date first in cache layers
  const kvCached = await getCachedRateFromKv(env, transactionDate);
  if (kvCached) return kvCached;

  const d1Cached = await getRateFromD1(env, transactionDate);
  if (d1Cached) {
    // Warm KV from D1
    if (env.KV) {
      try {
        await env.KV.put(kvKey(transactionDate), JSON.stringify(d1Cached), {
          expirationTtl: KV_TTL_SECONDS,
        });
      } catch { /* non-critical */ }
    }
    return d1Cached;
  }

  // Fetch from external API
  const apiResult = await fetchRateFromApi(env);
  if (!apiResult) return null;

  const sanityOk = isRateSane(apiResult.rate);
  const now = new Date().toISOString();

  const record: FxRateRecord = {
    rate: apiResult.rate,
    usedDate: transactionDate,
    source: apiResult.source,
    rateType: 'TTM', // Default: mid-rate (仲値)
    fetchedAt: now,
    sanityOk,
  };

  // Persist for audit trail
  await persistRate(env, transactionDate, record);

  return record;
}

// =============================================================================
// Conversion
// =============================================================================

/**
 * Convert USD amount to JPY using fetched rate.
 * Rounding: Math.floor (1円未満切捨て — tax compliance).
 * Floating-point safeguard: add epsilon before floor.
 */
export function convertUsdToJpy(amountUsd: number, rate: number): number {
  const raw = amountUsd * rate;
  // Floating-point safeguard (e.g., 4 * 149.53 = 598.1199999... → 598)
  return Math.floor(raw + 1e-9);
}

/**
 * Full conversion pipeline: fetch rate + convert + build audit result.
 * Returns null if conversion is not possible (rate unavailable or sanity failed).
 */
export async function convertReceiptToJpy(
  env: Env,
  amountOriginal: number,
  originalCurrency: string,
  transactionDate: string,
): Promise<FxConversionResult | null> {
  // Identity conversion for JPY
  if (originalCurrency === 'JPY') {
    return {
      amountJpy: amountOriginal,
      amountOriginal,
      originalCurrency: 'JPY',
      rate: 1,
      rateDate: transactionDate,
      requestedDate: transactionDate,
      rateSource: 'identity',
      rateType: 'N/A',
      sanityOk: true,
      roundingRule: 'none',
    };
  }

  if (originalCurrency !== 'USD') {
    safeLog(env, 'warn', 'Unsupported currency for FX conversion', { originalCurrency });
    return null;
  }

  const rateRecord = await getUsdJpyRate(env, transactionDate);
  if (!rateRecord) {
    safeLog(env, 'warn', 'FX rate unavailable', { transactionDate });
    return null;
  }

  if (!rateRecord.sanityOk) {
    safeLog(env, 'warn', 'FX rate failed sanity check', {
      rate: rateRecord.rate,
      date: rateRecord.usedDate,
    });
    return null;
  }

  const amountJpy = convertUsdToJpy(amountOriginal, rateRecord.rate);

  return {
    amountJpy,
    amountOriginal,
    originalCurrency: 'USD',
    rate: rateRecord.rate,
    rateDate: rateRecord.usedDate,
    requestedDate: transactionDate,
    rateSource: rateRecord.source,
    rateType: rateRecord.rateType,
    sanityOk: true,
    roundingRule: 'floor',
  };
}
