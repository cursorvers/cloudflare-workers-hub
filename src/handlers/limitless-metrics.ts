/**
 * Limitless Metrics API Handler (Phase 5)
 *
 * Provides aggregated metrics for reflections and PHI detection:
 * - GET /api/limitless/metrics?period=7d|30d|90d
 */

import { Env } from '../types';
import { safeLog } from '../utils/log-sanitizer';
import { supabaseSelect, type SupabaseConfig } from '../services/supabase-client';
import {
  LimitlessMetricsPeriodSchema,
  LimitlessMetricsResponseSchema,
  type LimitlessMetricsPeriod,
  type LimitlessMetricsResponse,
} from '../schemas/user-reflections';

const CACHE_TTL_SECONDS = 60 * 15;
const CACHE_PREFIX = 'limitless:metrics';
const DEFAULT_PERIOD: LimitlessMetricsPeriod = '30d';

interface HighlightMetricsRow {
  highlight_time: string;
  reviewed_at: string | null;
}

interface ReflectionMetricsRow {
  contains_phi: boolean;
  phi_approved: boolean;
  created_at: string;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function readMetricsCache(
  env: Env,
  cacheKey: string
): Promise<LimitlessMetricsResponse | null> {
  if (!env.CACHE) return null;

  try {
    const cached = await env.CACHE.get(cacheKey);
    if (!cached) return null;
    return JSON.parse(cached) as LimitlessMetricsResponse;
  } catch (error) {
    safeLog.warn('[Limitless Metrics] Cache read failed', {
      error: String(error),
    });
    return null;
  }
}

async function writeMetricsCache(
  env: Env,
  cacheKey: string,
  data: LimitlessMetricsResponse
): Promise<void> {
  if (!env.CACHE) return;

  try {
    await env.CACHE.put(cacheKey, JSON.stringify(data), {
      expirationTtl: CACHE_TTL_SECONDS,
    });
  } catch (error) {
    safeLog.warn('[Limitless Metrics] Cache write failed', {
      error: String(error),
    });
  }
}

function getPeriodRange(period: LimitlessMetricsPeriod): { start: Date; end: Date } {
  const daysMap: Record<LimitlessMetricsPeriod, number> = {
    '7d': 7,
    '30d': 30,
    '90d': 90,
  };

  const end = new Date();
  const start = new Date(end.getTime() - daysMap[period] * 24 * 60 * 60 * 1000);
  return { start, end };
}

function roundPercentage(value: number): number {
  return Math.round(value * 100) / 100;
}

function buildMetricsResponse(
  highlights: HighlightMetricsRow[],
  reflections: ReflectionMetricsRow[],
  periodStart: Date,
  periodEnd: Date
): LimitlessMetricsResponse {
  const totalHighlights = highlights.length;
  const highlightsWithReflection = highlights.filter((row) => row.reviewed_at).length;
  const reflectionPercentage = totalHighlights
    ? roundPercentage((highlightsWithReflection / totalHighlights) * 100)
    : 0;

  const totalScanned = reflections.length;
  const phiDetected = reflections.filter((row) => row.contains_phi).length;
  const phiFalsePositives = reflections.filter(
    (row) => row.contains_phi && !row.phi_approved
  ).length;
  const falsePositiveRate = phiDetected
    ? roundPercentage((phiFalsePositives / phiDetected) * 100)
    : 0;

  const responseTimes = highlights
    .filter((row) => row.reviewed_at)
    .map((row) => {
      const highlightTime = new Date(row.highlight_time).getTime();
      const reviewedTime = row.reviewed_at ? new Date(row.reviewed_at).getTime() : NaN;
      const diffHours = (reviewedTime - highlightTime) / (1000 * 60 * 60);
      return Number.isFinite(diffHours) && diffHours >= 0 ? diffHours : null;
    })
    .filter((value): value is number => value !== null);

  const avgHours = responseTimes.length
    ? roundPercentage(responseTimes.reduce((sum, value) => sum + value, 0) / responseTimes.length)
    : 0;
  const within48hCount = responseTimes.filter((value) => value <= 48).length;
  const within48hPercentage = responseTimes.length
    ? roundPercentage((within48hCount / responseTimes.length) * 100)
    : 0;

  const response: LimitlessMetricsResponse = {
    reflection_rate: {
      total_highlights: totalHighlights,
      with_reflection: highlightsWithReflection,
      percentage: reflectionPercentage,
    },
    phi_detection: {
      total_scanned: totalScanned,
      phi_detected: phiDetected,
      false_positive_rate: falsePositiveRate,
    },
    response_time: {
      avg_hours: avgHours,
      within_48h_percentage: within48hPercentage,
    },
    period: {
      start: periodStart.toISOString(),
      end: periodEnd.toISOString(),
    },
  };

  return LimitlessMetricsResponseSchema.parse(response);
}

export async function handleLimitlessMetricsAPI(
  request: Request,
  env: Env
): Promise<Response> {
  if (request.method !== 'GET') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  const url = new URL(request.url);
  const periodParam = url.searchParams.get('period') ?? DEFAULT_PERIOD;
  const periodValidation = LimitlessMetricsPeriodSchema.safeParse(periodParam);
  if (!periodValidation.success) {
    return jsonResponse(
      {
        error: 'Invalid period parameter',
        allowed: LimitlessMetricsPeriodSchema.options,
      },
      400
    );
  }

  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    safeLog.error('[Limitless Metrics] Supabase not configured');
    return jsonResponse({ error: 'Supabase not configured' }, 500);
  }

  const period = periodValidation.data;
  const cacheKey = `${CACHE_PREFIX}:${period}`;

  const cached = await readMetricsCache(env, cacheKey);
  if (cached) {
    return jsonResponse(cached);
  }

  const { start, end } = getPeriodRange(period);
  const startISO = start.toISOString();
  const endISO = end.toISOString();

  const config: SupabaseConfig = {
    url: env.SUPABASE_URL,
    serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
  };

  try {
    const highlightsQuery = `select=highlight_time,reviewed_at&highlight_time=gte.${startISO}&highlight_time=lt.${endISO}`;
    const reflectionsQuery = `select=contains_phi,phi_approved,created_at&created_at=gte.${startISO}&created_at=lt.${endISO}`;

    const [highlightsResult, reflectionsResult] = await Promise.all([
      supabaseSelect<HighlightMetricsRow>(config, 'lifelog_highlights', highlightsQuery),
      supabaseSelect<ReflectionMetricsRow>(config, 'user_reflections', reflectionsQuery),
    ]);

    if (highlightsResult.error) {
      safeLog.error('[Limitless Metrics] Failed to fetch highlights', {
        error: highlightsResult.error.message,
      });
      return jsonResponse({ error: 'Failed to fetch highlights' }, 500);
    }

    if (reflectionsResult.error) {
      safeLog.error('[Limitless Metrics] Failed to fetch reflections', {
        error: reflectionsResult.error.message,
      });
      return jsonResponse({ error: 'Failed to fetch reflections' }, 500);
    }

    const metrics = buildMetricsResponse(
      highlightsResult.data ?? [],
      reflectionsResult.data ?? [],
      start,
      end
    );

    await writeMetricsCache(env, cacheKey, metrics);
    return jsonResponse(metrics);
  } catch (error) {
    safeLog.error('[Limitless Metrics] Unexpected error building metrics', {
      error: String(error),
    });
    return jsonResponse({ error: 'Internal server error' }, 500);
  }
}
