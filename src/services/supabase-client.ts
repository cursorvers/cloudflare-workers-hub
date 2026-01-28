/**
 * Lightweight Supabase REST Client for Cloudflare Workers
 *
 * Uses PostgREST API directly via fetch (no npm dependency needed).
 * Only supports operations needed for the Limitless pipeline.
 */

import { safeLog } from '../utils/log-sanitizer';
import { CircuitBreaker } from '../utils/circuit-breaker';

// ============================================================================
// Types
// ============================================================================

export interface SupabaseConfig {
  url: string;
  serviceRoleKey: string;
}

interface SupabaseResponse<T = unknown> {
  data: T | null;
  error: SupabaseError | null;
}

interface SupabaseError {
  message: string;
  code: string;
  details: string;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Insert a row into a Supabase table
 *
 * @param config - Supabase connection config
 * @param table - Table name
 * @param data - Row data to insert
 * @returns Inserted row data
 */
export async function supabaseInsert<T = unknown>(
  config: SupabaseConfig,
  table: string,
  data: Record<string, unknown>
): Promise<SupabaseResponse<T>> {
  return supabaseRequest<T>(config, table, {
    method: 'POST',
    headers: {
      'Prefer': 'return=representation',
    },
    body: JSON.stringify(data),
  });
}

/**
 * Upsert a row into a Supabase table (insert or update on conflict)
 *
 * @param config - Supabase connection config
 * @param table - Table name
 * @param data - Row data to upsert
 * @param onConflict - Column(s) to use for conflict resolution
 * @returns Upserted row data
 */
export async function supabaseUpsert<T = unknown>(
  config: SupabaseConfig,
  table: string,
  data: Record<string, unknown>,
  onConflict: string
): Promise<SupabaseResponse<T>> {
  return supabaseRequest<T>(config, table, {
    method: 'POST',
    headers: {
      'Prefer': 'return=representation,resolution=merge-duplicates',
    },
    body: JSON.stringify(data),
    queryParams: `on_conflict=${onConflict}`,
  });
}

/**
 * Update rows matching a filter
 *
 * @param config - Supabase connection config
 * @param table - Table name
 * @param data - Fields to update
 * @param filter - PostgREST filter string (e.g., "id=eq.xxx")
 * @returns Updated rows
 */
export async function supabaseUpdate<T = unknown>(
  config: SupabaseConfig,
  table: string,
  data: Record<string, unknown>,
  filter: string
): Promise<SupabaseResponse<T>> {
  return supabaseRequest<T>(config, table, {
    method: 'PATCH',
    headers: {
      'Prefer': 'return=representation',
    },
    body: JSON.stringify(data),
    queryParams: filter,
  });
}

/**
 * Select rows from a Supabase table
 *
 * @param config - Supabase connection config
 * @param table - Table name
 * @param query - PostgREST query string (e.g., "classification=eq.pending&limit=10")
 * @returns Array of matching rows
 */
export async function supabaseSelect<T = unknown>(
  config: SupabaseConfig,
  table: string,
  query: string
): Promise<SupabaseResponse<T[]>> {
  const result = await supabaseRequest<T[]>(config, table, {
    method: 'GET',
    queryParams: query,
  });
  return {
    data: result.data ?? [],
    error: result.error,
  };
}

// ============================================================================
// Internal
// ============================================================================

/** Maximum number of retry attempts for transient failures */
const MAX_RETRIES = 3;

/** Base delay in ms for exponential backoff (doubles each retry) */
const BASE_DELAY_MS = 500;

/** Request timeout in ms */
const REQUEST_TIMEOUT_MS = 10_000;

/** HTTP status codes that are safe to retry */
const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);

// Circuit breaker for Supabase API
const supabaseCircuitBreaker = new CircuitBreaker('SupabaseAPI', {
  failureThreshold: 5,
  resetTimeoutMs: 60_000, // 1 minute
  successThreshold: 2,
});

interface RequestOptions {
  method: string;
  headers?: Record<string, string>;
  body?: string;
  queryParams?: string;
}

async function supabaseRequest<T>(
  config: SupabaseConfig,
  table: string,
  options: RequestOptions
): Promise<SupabaseResponse<T>> {
  const url = options.queryParams
    ? `${config.url}/rest/v1/${table}?${options.queryParams}`
    : `${config.url}/rest/v1/${table}`;

  return supabaseCircuitBreaker.execute(async () => {
    let lastError: SupabaseError | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, delay));
        safeLog.warn('[Supabase] Retrying request', {
          table,
          method: options.method,
          attempt,
        });
      }

      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

        const response = await fetch(url, {
          method: options.method,
          headers: {
            'Authorization': `Bearer ${config.serviceRoleKey}`,
            'apikey': config.serviceRoleKey,
            'Content-Type': 'application/json',
            ...options.headers,
          },
          body: options.body,
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          const errorBody = await response.text();
          let errorData: SupabaseError;
          try {
            errorData = JSON.parse(errorBody);
          } catch {
            errorData = {
              message: errorBody.substring(0, 200),
              code: String(response.status),
              details: '',
            };
          }

          // Retry on transient errors
          if (RETRYABLE_STATUS_CODES.has(response.status) && attempt < MAX_RETRIES) {
            lastError = errorData;
            continue;
          }

          safeLog.error('[Supabase] Request failed', {
            table,
            method: options.method,
            status: response.status,
            error: errorData.message,
            attempts: attempt + 1,
          });

          return { data: null, error: errorData };
        }

        // Handle empty responses (204 No Content)
        if (response.status === 204) {
          return { data: null, error: null };
        }

        const data = await response.json() as T;
        return { data, error: null };
      } catch (error) {
        const isTimeout = error instanceof DOMException && error.name === 'AbortError';
        const errorMessage = isTimeout ? 'Request timeout' : String(error);

        lastError = {
          message: errorMessage,
          code: isTimeout ? 'TIMEOUT' : 'NETWORK_ERROR',
          details: '',
        };

        // Retry on network/timeout errors
        if (attempt < MAX_RETRIES) {
          continue;
        }

        safeLog.error('[Supabase] Network error', {
          table,
          method: options.method,
          error: errorMessage,
          attempts: attempt + 1,
        });
      }
    }

    return {
      data: null,
      error: lastError ?? {
        message: 'Request failed after retries',
        code: 'MAX_RETRIES_EXCEEDED',
        details: '',
      },
    };
  });
}
