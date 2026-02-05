/**
 * AI Usage API Handler
 *
 * GET /api/usage returns aggregated usage data for:
 * - Claude
 * - Codex
 * - GLM
 * - Gemini
 *
 * Uses USAGE_CACHE KV with 5-minute TTL.
 */

import { Env } from '../types';
import { safeLog } from '../utils/log-sanitizer';
import { fetchUsageSummary, type UsageSummaryResponse } from '../services/usage-service';

const USAGE_CACHE_KEY = 'usage_summary';
const CACHE_TTL_SECONDS = 300;

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function readUsageCache(env: Env): Promise<UsageSummaryResponse | null> {
  if (!env.USAGE_CACHE) return null;

  try {
    const cached = await env.USAGE_CACHE.get(USAGE_CACHE_KEY);
    if (!cached) return null;
    return JSON.parse(cached) as UsageSummaryResponse;
  } catch (error) {
    safeLog.warn('[Usage API] Cache read failed', { error: String(error) });
    return null;
  }
}

async function writeUsageCache(env: Env, data: UsageSummaryResponse): Promise<void> {
  if (!env.USAGE_CACHE) return;

  try {
    await env.USAGE_CACHE.put(USAGE_CACHE_KEY, JSON.stringify(data), {
      expirationTtl: CACHE_TTL_SECONDS,
    });
  } catch (error) {
    safeLog.warn('[Usage API] Cache write failed', { error: String(error) });
  }
}

export async function handleUsageAPI(
  request: Request,
  env: Env,
  _path: string
): Promise<Response> {
  if (request.method !== 'GET') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  try {
    const cached = await readUsageCache(env);
    if (cached) {
      return jsonResponse(cached);
    }

    const summary = await fetchUsageSummary(env);
    await writeUsageCache(env, summary);
    return jsonResponse(summary);
  } catch (error) {
    safeLog.error('[Usage API] Failed to load usage summary', { error: String(error) });
    return jsonResponse({ error: 'Failed to load usage summary' }, 500);
  }
}
