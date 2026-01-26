/**
 * Lightweight Supabase REST Client for Cloudflare Workers
 *
 * Uses PostgREST API directly via fetch (no npm dependency needed).
 * Only supports operations needed for the Limitless pipeline.
 */

import { safeLog } from '../utils/log-sanitizer';

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

  try {
    const response = await fetch(url, {
      method: options.method,
      headers: {
        'Authorization': `Bearer ${config.serviceRoleKey}`,
        'apikey': config.serviceRoleKey,
        'Content-Type': 'application/json',
        ...options.headers,
      },
      body: options.body,
    });

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

      safeLog.error('[Supabase] Request failed', {
        table,
        method: options.method,
        status: response.status,
        error: errorData.message,
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
    safeLog.error('[Supabase] Network error', {
      table,
      method: options.method,
      error: String(error),
    });

    return {
      data: null,
      error: {
        message: String(error),
        code: 'NETWORK_ERROR',
        details: '',
      },
    };
  }
}
