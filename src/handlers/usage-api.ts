/**
 * AI Usage API Handler
 *
 * Aggregates usage data from multiple AI services:
 * - Anthropic (Claude) - API usage
 * - OpenAI (Codex) - API usage
 * - Z.AI (GLM) - Subscription quota (manual for now)
 * - Gemini - Free tier quota (manual for now)
 *
 * Features:
 * - KV caching with 5-minute TTL
 * - Automatic critical quota detection
 * - CORS support for FUGUE UI
 */

import { Env } from '../types';
import { safeLog } from '../utils/log-sanitizer';

// Cache key and TTL
const USAGE_CACHE_KEY = 'ai_usage_data';
const CACHE_TTL_SECONDS = 300; // 5 minutes

// Types
interface Quota {
  period: string;
  used: number;
  limit: number;
  budget?: string;
  resetAt?: string;
}

interface AgentUsage {
  quotas: Quota[];
  critical?: Quota;
  lastUpdated?: string;
  source: 'api' | 'manual' | 'cached';
}

interface UsageResponse {
  timestamp: string;
  agents: Record<string, AgentUsage>;
  cacheHit: boolean;
}

/**
 * Fetch Anthropic (Claude) usage from Console API
 * Note: Anthropic Console API requires admin API key with billing scope
 * For Claude Max/Pro subscriptions, usage is tracked differently
 */
async function fetchAnthropicUsage(env: Env): Promise<AgentUsage | null> {
  // Claude Max subscription tracking
  // The Anthropic API doesn't expose subscription limits directly
  // We'll use manual values from KV for now, updated via admin API
  try {
    const manualData = await env.CACHE?.get('claude_usage_manual');
    if (manualData) {
      const data = JSON.parse(manualData);
      return {
        quotas: data.quotas || [],
        critical: findCriticalQuota(data.quotas || []),
        lastUpdated: data.lastUpdated,
        source: 'manual',
      };
    }
  } catch (e) {
    safeLog.error('[Usage API] Failed to fetch Claude manual data', { error: String(e) });
  }

  // Default fallback (should be updated via /api/usage/claude endpoint)
  return {
    quotas: [
      { period: 'weekly', used: 0, limit: 100, resetAt: 'unknown' },
    ],
    critical: { period: 'weekly', used: 0, limit: 100 },
    source: 'manual',
  };
}

/**
 * Fetch OpenAI (Codex) usage from Dashboard API
 * Note: OpenAI usage API requires organization admin access
 */
async function fetchOpenAIUsage(env: Env): Promise<AgentUsage | null> {
  if (!env.OPENAI_API_KEY) {
    // Check for manual data
    try {
      const manualData = await env.CACHE?.get('codex_usage_manual');
      if (manualData) {
        const data = JSON.parse(manualData);
        return {
          quotas: data.quotas || [],
          critical: findCriticalQuota(data.quotas || []),
          lastUpdated: data.lastUpdated,
          source: 'manual',
        };
      }
    } catch (e) {
      safeLog.error('[Usage API] Failed to fetch Codex manual data', { error: String(e) });
    }

    return {
      quotas: [
        { period: 'monthly', used: 0, limit: 100, budget: '$50' },
      ],
      source: 'manual',
    };
  }

  // TODO: Implement OpenAI billing API integration
  // The API requires organization admin permissions
  // For now, use manual tracking
  return {
    quotas: [
      { period: 'monthly', used: 0, limit: 100, budget: '$50' },
    ],
    source: 'manual',
  };
}

/**
 * Fetch Z.AI (GLM) usage
 * Z.AI doesn't have a public API for usage tracking
 * Uses manual values from KV
 */
async function fetchGLMUsage(env: Env): Promise<AgentUsage | null> {
  try {
    const manualData = await env.CACHE?.get('glm_usage_manual');
    if (manualData) {
      const data = JSON.parse(manualData);
      return {
        quotas: data.quotas || [],
        critical: findCriticalQuota(data.quotas || []),
        lastUpdated: data.lastUpdated,
        source: 'manual',
      };
    }
  } catch (e) {
    safeLog.error('[Usage API] Failed to fetch GLM manual data', { error: String(e) });
  }

  // Default (5h rolling + monthly web)
  return {
    quotas: [
      { period: '5h_rolling', used: 0, limit: 100 },
      { period: 'monthly_web', used: 0, limit: 1000 },
    ],
    source: 'manual',
  };
}

/**
 * Fetch Gemini usage (free tier)
 */
async function fetchGeminiUsage(env: Env): Promise<AgentUsage | null> {
  try {
    const manualData = await env.CACHE?.get('gemini_usage_manual');
    if (manualData) {
      const data = JSON.parse(manualData);
      return {
        quotas: data.quotas || [],
        critical: findCriticalQuota(data.quotas || []),
        lastUpdated: data.lastUpdated,
        source: 'manual',
      };
    }
  } catch (e) {
    safeLog.error('[Usage API] Failed to fetch Gemini manual data', { error: String(e) });
  }

  return {
    quotas: [
      { period: 'daily', used: 0, limit: 60 },
    ],
    source: 'manual',
  };
}

/**
 * Find the most critical quota (closest to limit)
 */
function findCriticalQuota(quotas: Quota[]): Quota | undefined {
  if (!quotas.length) return undefined;

  let critical: Quota | undefined;
  let highestUsagePercent = -1;

  for (const quota of quotas) {
    if (quota.limit <= 0) continue;
    const usagePercent = (quota.used / quota.limit) * 100;
    if (usagePercent > highestUsagePercent) {
      highestUsagePercent = usagePercent;
      critical = quota;
    }
  }

  return critical;
}

/**
 * Verify API key for usage endpoints
 */
function verifyUsageKey(request: Request, env: Env): boolean {
  const expectedKey = env.MONITORING_API_KEY || env.ADMIN_API_KEY || env.QUEUE_API_KEY;

  // Allow public read access for FUGUE UI
  // Write operations (POST) require authentication
  if (request.method === 'GET') {
    return true;
  }

  if (!expectedKey) {
    safeLog.warn('[Usage API] No API key configured for write operations');
    return true; // Allow for initial setup
  }

  const apiKey = request.headers.get('X-API-Key');
  if (!apiKey) {
    return false;
  }

  // Constant-time comparison
  let result = apiKey.length === expectedKey.length ? 0 : 1;
  const maxLen = Math.max(apiKey.length, expectedKey.length);
  for (let i = 0; i < maxLen; i++) {
    const a = i < apiKey.length ? apiKey.charCodeAt(i) : 0;
    const b = i < expectedKey.length ? expectedKey.charCodeAt(i) : 0;
    result |= a ^ b;
  }

  return result === 0;
}

/**
 * Handle GET /api/usage - Fetch aggregated usage data
 */
async function handleGetUsage(env: Env): Promise<Response> {
  // Check cache first
  if (env.CACHE) {
    try {
      const cached = await env.CACHE.get(USAGE_CACHE_KEY);
      if (cached) {
        const data = JSON.parse(cached) as UsageResponse;
        data.cacheHit = true;
        return new Response(JSON.stringify(data), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
    } catch (e) {
      safeLog.warn('[Usage API] Cache read failed', { error: String(e) });
    }
  }

  // Fetch from all sources in parallel
  const [claude, codex, glm, gemini] = await Promise.all([
    fetchAnthropicUsage(env),
    fetchOpenAIUsage(env),
    fetchGLMUsage(env),
    fetchGeminiUsage(env),
  ]);

  const response: UsageResponse = {
    timestamp: new Date().toISOString(),
    agents: {
      claude: claude || { quotas: [], source: 'manual' },
      codex: codex || { quotas: [], source: 'manual' },
      glm: glm || { quotas: [], source: 'manual' },
      gemini: gemini || { quotas: [], source: 'manual' },
    },
    cacheHit: false,
  };

  // Cache the response
  if (env.CACHE) {
    try {
      await env.CACHE.put(USAGE_CACHE_KEY, JSON.stringify(response), {
        expirationTtl: CACHE_TTL_SECONDS,
      });
    } catch (e) {
      safeLog.warn('[Usage API] Cache write failed', { error: String(e) });
    }
  }

  return new Response(JSON.stringify(response), {
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Handle POST /api/usage/:agent - Update manual usage data
 */
async function handleUpdateUsage(
  request: Request,
  env: Env,
  agent: string
): Promise<Response> {
  const validAgents = ['claude', 'codex', 'glm', 'gemini'];
  if (!validAgents.includes(agent)) {
    return new Response(JSON.stringify({ error: 'Invalid agent' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let body: { quotas: Quota[] };
  try {
    body = await request.json();
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!body.quotas || !Array.isArray(body.quotas)) {
    return new Response(JSON.stringify({ error: 'quotas array required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Store manual data
  const cacheKey = `${agent}_usage_manual`;
  const data = {
    quotas: body.quotas,
    lastUpdated: new Date().toISOString(),
  };

  if (env.CACHE) {
    try {
      await env.CACHE.put(cacheKey, JSON.stringify(data));
      // Invalidate aggregated cache
      await env.CACHE.delete(USAGE_CACHE_KEY);
    } catch (e) {
      safeLog.error('[Usage API] Failed to store manual data', { error: String(e) });
      return new Response(JSON.stringify({ error: 'Failed to store data' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  safeLog.log('[Usage API] Updated manual usage', { agent, quotas: body.quotas.length });

  return new Response(JSON.stringify({ success: true, data }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Main handler for /api/usage endpoints
 */
export async function handleUsageAPI(
  request: Request,
  env: Env,
  path: string
): Promise<Response> {
  // CORS headers
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-API-Key',
  };

  // Handle CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // Verify API key for write operations
  if (request.method === 'POST' && !verifyUsageKey(request, env)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // Route handling
  const pathParts = path.replace('/api/usage', '').split('/').filter(Boolean);

  // GET /api/usage - Fetch all usage data
  if (request.method === 'GET' && pathParts.length === 0) {
    const response = await handleGetUsage(env);
    // Add CORS headers
    const newResponse = new Response(response.body, response);
    Object.entries(corsHeaders).forEach(([key, value]) => {
      newResponse.headers.set(key, value);
    });
    return newResponse;
  }

  // POST /api/usage/:agent - Update specific agent usage
  if (request.method === 'POST' && pathParts.length === 1) {
    const response = await handleUpdateUsage(request, env, pathParts[0]);
    const newResponse = new Response(response.body, response);
    Object.entries(corsHeaders).forEach(([key, value]) => {
      newResponse.headers.set(key, value);
    });
    return newResponse;
  }

  return new Response(JSON.stringify({ error: 'Not found' }), {
    status: 404,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
