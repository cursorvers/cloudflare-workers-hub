/**
 * Specialist Health Probing — Active health checks for LLM providers.
 *
 * Probes OpenAI, GLM (ZhipuAI), and Gemini with lightweight requests
 * to detect availability issues before they cause execution failures.
 *
 * Security: no credentials in logs, probe requests carry no sensitive data.
 * All state is immutable and frozen.
 */

// =============================================================================
// Constants
// =============================================================================

/** Probe timeout (5 seconds — well under CF Worker 30s limit) */
export const PROBE_TIMEOUT_MS = 5_000;

/** Maximum probe history per provider */
export const MAX_PROBE_HISTORY = 10;

/** Probe interval (2 minutes — balance between freshness and cost) */
export const PROBE_INTERVAL_MS = 2 * 60 * 1000;

// =============================================================================
// Types
// =============================================================================

export const PROVIDER_IDS = ['openai', 'glm', 'gemini'] as const;
export type ProviderId = typeof PROVIDER_IDS[number];

export interface ProbeResult {
  readonly provider: ProviderId;
  readonly available: boolean;
  readonly latencyMs: number;
  readonly error?: string;
  readonly timestamp: number;
}

export interface ProviderHealth {
  readonly provider: ProviderId;
  readonly available: boolean;
  readonly lastProbe: ProbeResult | null;
  readonly recentResults: readonly ProbeResult[];
  readonly successRate: number; // 0.0 - 1.0
  readonly avgLatencyMs: number;
}

export interface HealthProbeState {
  readonly providers: ReadonlyMap<ProviderId, ProviderHealth>;
  readonly lastProbeAt: number;
}

// =============================================================================
// Pure State Functions
// =============================================================================

export function createHealthProbeState(): HealthProbeState {
  const providers = new Map<ProviderId, ProviderHealth>();
  for (const id of PROVIDER_IDS) {
    providers.set(id, Object.freeze({
      provider: id,
      available: true, // Optimistic default
      lastProbe: null,
      recentResults: Object.freeze([]),
      successRate: 1.0,
      avgLatencyMs: 0,
    }));
  }

  return Object.freeze({
    providers,
    lastProbeAt: 0,
  });
}

/**
 * Record a probe result for a provider.
 * Maintains a sliding window of MAX_PROBE_HISTORY results.
 */
export function recordProbeResult(
  state: HealthProbeState,
  result: ProbeResult,
): HealthProbeState {
  const current = state.providers.get(result.provider);
  if (!current) return state;

  const recentResults = [
    result,
    ...current.recentResults.slice(0, MAX_PROBE_HISTORY - 1),
  ];

  const successCount = recentResults.filter((r) => r.available).length;
  const successRate = recentResults.length > 0 ? successCount / recentResults.length : 1.0;

  const totalLatency = recentResults
    .filter((r) => r.available)
    .reduce((sum, r) => sum + r.latencyMs, 0);
  const availableCount = recentResults.filter((r) => r.available).length;
  const avgLatencyMs = availableCount > 0 ? totalLatency / availableCount : 0;

  const updatedHealth: ProviderHealth = Object.freeze({
    provider: result.provider,
    available: result.available,
    lastProbe: result,
    recentResults: Object.freeze(recentResults),
    successRate,
    avgLatencyMs,
  });

  const newProviders = new Map(state.providers);
  newProviders.set(result.provider, updatedHealth);

  return Object.freeze({
    providers: newProviders,
    lastProbeAt: result.timestamp,
  });
}

/**
 * Check if probing is due based on interval.
 */
export function isProbeOverdue(state: HealthProbeState, nowMs: number): boolean {
  return nowMs - state.lastProbeAt >= PROBE_INTERVAL_MS;
}

/**
 * Get a snapshot of all provider health for status reporting.
 */
export function getHealthSnapshot(
  state: HealthProbeState,
): readonly ProviderHealth[] {
  return Object.freeze(
    [...state.providers.values()].map((h) => Object.freeze({ ...h })),
  );
}

/**
 * Check if a specific provider is healthy (success rate > 50%).
 */
export function isProviderHealthy(
  state: HealthProbeState,
  provider: ProviderId,
): boolean {
  const health = state.providers.get(provider);
  if (!health || !health.lastProbe) return true; // No data = optimistic
  return health.successRate > 0.5;
}

// =============================================================================
// Probe Execution (Side Effects — isolated)
// =============================================================================

/**
 * Execute a lightweight probe against a provider.
 * Security: no sensitive data in probe requests.
 */
export async function probeProvider(
  provider: ProviderId,
  apiKey: string | undefined,
): Promise<ProbeResult> {
  const startMs = Date.now();

  // No API key = unavailable (no point probing)
  if (!apiKey) {
    return Object.freeze({
      provider,
      available: false,
      latencyMs: 0,
      error: 'no API key configured',
      timestamp: startMs,
    });
  }

  try {
    const endpoint = getProbeEndpoint(provider);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

    const response = await fetch(endpoint, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    const latencyMs = Date.now() - startMs;

    // 2xx or 401 (auth works, key might be scoped) = available
    // 429 = rate limited but available
    const available = response.status < 500;

    return Object.freeze({
      provider,
      available,
      latencyMs,
      error: available ? undefined : `HTTP ${response.status}`,
      timestamp: startMs,
    });
  } catch (err) {
    const latencyMs = Date.now() - startMs;
    const isTimeout = err instanceof Error && err.name === 'AbortError';

    return Object.freeze({
      provider,
      available: false,
      latencyMs,
      error: isTimeout ? 'timeout' : (err instanceof Error ? err.message : 'unknown'),
      timestamp: startMs,
    });
  }
}

function getProbeEndpoint(provider: ProviderId): string {
  switch (provider) {
    case 'openai':
      return 'https://api.openai.com/v1/models';
    case 'glm':
      return 'https://open.bigmodel.cn/api/paas/v4/models';
    case 'gemini':
      return 'https://generativelanguage.googleapis.com/v1/models';
    default:
      return '';
  }
}
