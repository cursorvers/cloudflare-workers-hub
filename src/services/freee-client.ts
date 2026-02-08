/**
 * freee API Client
 *
 * Handles authentication, rate limiting, and API calls to freee accounting API
 * - OAuth 2.0 authentication with AES-GCM encrypted refresh token
 * - Exponential backoff retry logic
 * - Idempotency guarantees
 * - Rate limit handling (300 requests/hour)
 */

import type { Env } from '../types';
import { safeLog } from '../utils/log-sanitizer';

// =============================================================================
// Constants
// =============================================================================

const IV_LENGTH = 12;
const KEY_LENGTH = 32;

// =============================================================================
// Types
// =============================================================================

export interface FreeeConfig {
  clientId: string;
  clientSecret: string;
  companyId: string;
}

export interface OAuthTokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
}

export interface FreeeReceipt {
  id: number;
  company_id: number;
  description: string;
  receipt_metadatum: {
    file_name: string;
    file_size: number;
  };
  issue_date: string;
  document_type: string;
}

export interface FreeeUploadResult {
  receipt: FreeeReceipt;
}

export interface FreeeDealDetail {
  account_item_id: number;
  tax_code: number;
  amount: number;
  description?: string;
}

export interface FreeeDealCreateParams {
  company_id: number;
  issue_date: string;
  type: 'expense' | 'income';
  partner_id?: number;
  ref_number?: string;
  details: FreeeDealDetail[];
}

export interface FreeeDeal {
  id: number;
  company_id: number;
  issue_date: string;
  type: string;
  partner_id?: number;
}

export interface FreeeDealResult {
  deal: FreeeDeal;
}

// =============================================================================
// ApiError (typed error with status for retry logic)
// =============================================================================

export class ApiError extends Error {
  readonly status: number;
  readonly responseHeaders: Headers | null;

  constructor(message: string, status: number, headers?: Headers) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.responseHeaders = headers ?? null;
  }

  get isRetryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

// =============================================================================
// OAuth Token Management
// =============================================================================

/**
 * Encrypt refresh token with AES-GCM
 */
async function encryptToken(token: string, key: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(token);
  const keyData = encoder.encode(key.padEnd(KEY_LENGTH, '0').slice(0, KEY_LENGTH));

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'AES-GCM' },
    false,
    ['encrypt']
  );

  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    cryptoKey,
    data
  );

  // Combine IV + encrypted data
  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(encrypted), iv.length);

  // Base64 encode
  return btoa(String.fromCharCode(...combined));
}

/**
 * Decrypt refresh token
 */
async function decryptToken(encrypted: string, key: string): Promise<string> {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(key.padEnd(KEY_LENGTH, '0').slice(0, KEY_LENGTH));

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'AES-GCM' },
    false,
    ['decrypt']
  );

  // Base64 decode
  const combined = Uint8Array.from(atob(encrypted), (c) => c.charCodeAt(0));

  // Split IV + encrypted data
  const iv = combined.slice(0, IV_LENGTH);
  const data = combined.slice(IV_LENGTH);

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    cryptoKey,
    data
  );

  const decoder = new TextDecoder();
  return decoder.decode(decrypted);
}

// =============================================================================
// freee API Client
// =============================================================================

type FreeeEnv = Env & {
  DB: D1Database;
  FREEE_CLIENT_ID: string;
  FREEE_CLIENT_SECRET: string;
  FREEE_ENCRYPTION_KEY: string;
};

export class FreeeClient {
  private env: FreeeEnv;
  private config: FreeeConfig;
  private baseUrl = 'https://api.freee.co.jp/api/1';
  // Invocation-local cache: avoids repeated KV reads and token refreshes within a single worker run.
  private cachedAccessToken: string | null = null;
  private cachedAccessTokenExpiryMs: number | null = null;
  private cachedCompanyId: string | null = null;

  constructor(env: Env) {
    const requireEnv = (value: string | undefined, name: string): string => {
      if (!value) {
        throw new Error(`Missing required env var: ${name}`);
      }
      return value;
    };

    if (!env.DB) {
      throw new Error('Missing required D1 binding: DB');
    }

    const clientId = requireEnv(env.FREEE_CLIENT_ID, 'FREEE_CLIENT_ID');
    const clientSecret = requireEnv(
      env.FREEE_CLIENT_SECRET,
      'FREEE_CLIENT_SECRET'
    );
    const encryptionKey = requireEnv(
      env.FREEE_ENCRYPTION_KEY,
      'FREEE_ENCRYPTION_KEY'
    );

    this.env = {
      ...env,
      DB: env.DB,
      FREEE_CLIENT_ID: clientId,
      FREEE_CLIENT_SECRET: clientSecret,
      FREEE_ENCRYPTION_KEY: encryptionKey,
    };
    this.config = {
      clientId,
      clientSecret,
      // company_id can be stored in D1 during OAuth callback and resolved lazily.
      companyId: env.FREEE_COMPANY_ID || '',
    };
  }

  /**
   * Get valid access token (refresh if expired)
   */
  private async getAccessToken(): Promise<string> {
    if (
      this.cachedAccessToken &&
      this.cachedAccessTokenExpiryMs &&
      Date.now() < this.cachedAccessTokenExpiryMs
    ) {
      return this.cachedAccessToken;
    }

    // Check if access token is still valid (D1 persisted cache)
    let accessTokenExpiryMs: number | null = null;
    let accessToken: string | null = null;
    try {
      const row = await this.env.DB.prepare(
        `SELECT access_token, access_token_expires_at_ms, company_id
         FROM external_oauth_tokens
         WHERE provider = 'freee'
         LIMIT 1`
      ).first() as {
        access_token?: string | null;
        access_token_expires_at_ms?: number | null;
        company_id?: string | null;
      } | null;
      accessToken = row?.access_token ?? null;
      accessTokenExpiryMs = typeof row?.access_token_expires_at_ms === 'number' ? row.access_token_expires_at_ms : null;
      if (!this.cachedCompanyId && row?.company_id) {
        this.cachedCompanyId = row.company_id;
      }
    } catch (error) {
      safeLog(this.env, 'warn', 'D1 read failed while checking freee access token (continuing)', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (
      accessToken &&
      accessTokenExpiryMs &&
      Date.now() < accessTokenExpiryMs
    ) {
      this.cachedAccessToken = accessToken;
      this.cachedAccessTokenExpiryMs = accessTokenExpiryMs;
      return accessToken;
    }

    // Get encrypted refresh token from D1 for token refresh
    let encryptedRefreshToken: string | null = null;
    try {
      const row = await this.env.DB.prepare(
        `SELECT encrypted_refresh_token
         FROM external_oauth_tokens
         WHERE provider = 'freee'
         LIMIT 1`
      ).first() as { encrypted_refresh_token?: string | null } | null;
      encryptedRefreshToken = row?.encrypted_refresh_token ?? null;
    } catch (error) {
      safeLog(this.env, 'warn', 'D1 read failed while fetching freee refresh token', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // One-time migration path: if tokens are still in KV from older deployments, pull them into D1.
    // kv-optimizer:ignore
    if (!encryptedRefreshToken && (this.env as any).KV?.get) {
      try {
        const kv = (this.env as any).KV as KVNamespace;
        const kvEncrypted = await kv.get('freee:refresh_token'); // kv-optimizer:ignore
        const kvAccess = await kv.get('freee:access_token'); // kv-optimizer:ignore
        const kvExpiry = await kv.get('freee:access_token_expiry'); // kv-optimizer:ignore
        if (kvEncrypted) {
          const expiresAtMs = kvExpiry ? Number.parseInt(kvExpiry, 10) : null;
          await this.env.DB.prepare(
            `INSERT INTO external_oauth_tokens (provider, encrypted_refresh_token, access_token, access_token_expires_at_ms, updated_at, company_id)
             VALUES (
               'freee',
               ?,
               ?,
               ?,
               strftime('%s','now'),
               COALESCE((SELECT company_id FROM external_oauth_tokens WHERE provider='freee' LIMIT 1), NULL)
             )
             ON CONFLICT(provider) DO UPDATE SET
               encrypted_refresh_token=excluded.encrypted_refresh_token,
               access_token=excluded.access_token,
               access_token_expires_at_ms=excluded.access_token_expires_at_ms,
               company_id=COALESCE(external_oauth_tokens.company_id, excluded.company_id),
               updated_at=strftime('%s','now')`
          ).bind(kvEncrypted, kvAccess, expiresAtMs).run();
          encryptedRefreshToken = kvEncrypted;
          accessToken = kvAccess;
          accessTokenExpiryMs = expiresAtMs;
        }
      } catch (error) {
        safeLog(this.env, 'warn', 'KV->D1 token migration failed (continuing)', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (!encryptedRefreshToken) {
      throw new Error('No refresh token found and access token expired. Please re-authenticate.');
    }

    // Refresh access token
    const refreshToken = await decryptToken(
      encryptedRefreshToken,
      this.env.FREEE_ENCRYPTION_KEY
    );

    const response = await fetch('https://accounts.secure.freee.co.jp/public_api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        refresh_token: refreshToken,
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to refresh token: ${response.statusText}`);
    }

    const tokens: OAuthTokens = await response.json();

    // Store new tokens
    const newExpiryMs = Date.now() + (tokens.expires_in - 60) * 1000;
    this.cachedAccessToken = tokens.access_token;
    this.cachedAccessTokenExpiryMs = newExpiryMs;

    try {
      // Encrypt and store new refresh token
      const encryptedNewRefreshToken = await encryptToken(
        tokens.refresh_token,
        this.env.FREEE_ENCRYPTION_KEY
      );
      await this.env.DB.prepare(
        `INSERT INTO external_oauth_tokens (provider, encrypted_refresh_token, access_token, access_token_expires_at_ms, updated_at, company_id)
         VALUES (
           'freee',
           ?,
           ?,
           ?,
           strftime('%s','now'),
           COALESCE((SELECT company_id FROM external_oauth_tokens WHERE provider='freee' LIMIT 1), NULL)
         )
         ON CONFLICT(provider) DO UPDATE SET
           encrypted_refresh_token=excluded.encrypted_refresh_token,
           access_token=excluded.access_token,
           access_token_expires_at_ms=excluded.access_token_expires_at_ms,
           company_id=COALESCE(external_oauth_tokens.company_id, excluded.company_id),
           updated_at=strftime('%s','now')`
      ).bind(encryptedNewRefreshToken, tokens.access_token, newExpiryMs).run();
    } catch (error) {
      // Fail-open: allow processing to proceed even if D1 writes are blocked.
      // Note: if freee rotates refresh tokens, inability to persist may require re-auth later.
      safeLog(this.env, 'warn', 'D1 write failed while storing freee tokens (continuing)', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    safeLog(this.env, 'info', 'Access token refreshed', {});

    return tokens.access_token;
  }

  /**
   * Get valid access token (public for master cache integration)
   */
  async getAccessTokenPublic(): Promise<string> {
    return this.getAccessToken();
  }

  private async resolveCompanyId(): Promise<string> {
    // Prefer explicit env var.
    if (this.env.FREEE_COMPANY_ID) return this.env.FREEE_COMPANY_ID;
    if (this.cachedCompanyId) return this.cachedCompanyId;
    if (this.config.companyId) return this.config.companyId;

    // Try D1 cache.
    try {
      const row = await this.env.DB.prepare(
        `SELECT company_id
         FROM external_oauth_tokens
         WHERE provider = 'freee'
         LIMIT 1`
      ).first() as { company_id?: string | null } | null;
      if (row?.company_id) {
        this.cachedCompanyId = row.company_id;
        this.config.companyId = row.company_id;
        return row.company_id;
      }
    } catch (error) {
      safeLog(this.env, 'warn', 'D1 read failed while resolving freee company_id (continuing)', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Derive from API (requires access token).
    const payload = await this.request<{ companies?: Array<{ id: number; name?: string }> }>(
      'GET',
      '/companies'
    );
    const companies = Array.isArray(payload.companies) ? payload.companies : [];
    if (companies.length === 0) {
      throw new Error('freee: no companies returned for this account');
    }
    if (companies.length > 1) {
      safeLog(this.env, 'warn', '[freee] Multiple companies returned; defaulting to the first', {
        count: companies.length,
      });
    }
    const companyId = String(companies[0].id);

    // Persist back to D1 best-effort.
    try {
      await this.env.DB.prepare(
        `UPDATE external_oauth_tokens
         SET company_id = ?, updated_at = strftime('%s','now')
         WHERE provider = 'freee'`
      ).bind(companyId).run();
    } catch (error) {
      safeLog(this.env, 'warn', 'D1 write failed while persisting freee company_id (continuing)', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    this.cachedCompanyId = companyId;
    this.config.companyId = companyId;
    return companyId;
  }

  // Exposed for other services to avoid requiring FREEE_COMPANY_ID as a secret.
  async getCompanyId(): Promise<string> {
    return this.resolveCompanyId();
  }

  /**
   * Exponential backoff retry (only retries 5xx and 429, fails immediately on 4xx)
   */
  private async retryWithBackoff<T>(
    fn: () => Promise<T>,
    maxRetries = 3
  ): Promise<T> {
    let attempt = 0;
    while (attempt < maxRetries) {
      try {
        return await fn();
      } catch (error: unknown) {
        attempt++;

        // If error is ApiError with non-retryable status, fail immediately
        if (error instanceof ApiError && !error.isRetryable) {
          throw error;
        }

        if (attempt >= maxRetries) {
          throw error;
        }

        // Rate limited (429) - respect Retry-After header
        if (error instanceof ApiError && error.status === 429) {
          const retryAfter = error.responseHeaders?.get('Retry-After');
          const waitTime = retryAfter
            ? parseInt(retryAfter) * 1000
            : Math.pow(2, attempt) * 1000;

          safeLog(this.env, 'warn', 'Rate limited, retrying', {
            attempt,
            waitTime,
          });

          await new Promise((resolve) => setTimeout(resolve, waitTime));
        } else {
          // Exponential backoff for 5xx / network errors
          const waitTime = Math.pow(2, attempt) * 1000;
          await new Promise((resolve) => setTimeout(resolve, waitTime));
        }
      }
    }
    throw new Error('Max retries exceeded');
  }

  /**
   * Common request method (DRY: handles auth, retry, error wrapping)
   */
  async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown,
    idempotencyKey?: string
  ): Promise<T> {
    const accessToken = await this.getAccessToken();

    return this.retryWithBackoff(async () => {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${accessToken}`,
      };

      if (idempotencyKey) {
        headers['X-Idempotency-Key'] = idempotencyKey;
      }

      const init: RequestInit = { method, headers };

      if (body !== undefined && body !== null) {
        if (body instanceof FormData) {
          init.body = body;
        } else {
          headers['Content-Type'] = 'application/json';
          init.body = JSON.stringify(body);
        }
      }

      const response = await fetch(`${this.baseUrl}${path}`, init);

      if (!response.ok) {
        throw new ApiError(
          `freee API error: ${response.status} ${response.statusText}`,
          response.status,
          response.headers
        );
      }

      return response.json() as Promise<T>;
    });
  }

  /**
   * Upload receipt to freee File Box
   */
  async uploadReceipt(
    file: Blob,
    fileName: string,
    idempotencyKey: string
  ): Promise<FreeeUploadResult> {
    const accessToken = await this.getAccessToken();

    return this.retryWithBackoff(async () => {
      const companyId = await this.resolveCompanyId();
      const formData = new FormData();
      formData.append('receipt', file, fileName);
      formData.append('company_id', companyId);

      const response = await fetch(`${this.baseUrl}/receipts`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'X-Idempotency-Key': idempotencyKey,
        },
        body: formData,
      });

      if (!response.ok) {
        throw new ApiError(
          `freee API error: ${response.statusText}`,
          response.status,
          response.headers
        );
      }

      const result: FreeeUploadResult = await response.json();
      safeLog(this.env, 'info', 'Receipt uploaded to freee', {
        receiptId: result.receipt.id,
        fileName,
      });

      return result;
    });
  }

  /**
   * Get receipt by ID
   */
  async getReceipt(receiptId: number): Promise<FreeeReceipt> {
    const companyId = await this.resolveCompanyId();
    return this.request<{ receipt: FreeeReceipt }>(
      'GET',
      `/receipts/${receiptId}?company_id=${companyId}`
    ).then((result) => result.receipt);
  }

  /**
   * List receipts
   */
  async listReceipts(
    startDate?: string,
    endDate?: string
  ): Promise<FreeeReceipt[]> {
    const companyId = await this.resolveCompanyId();
    const params = new URLSearchParams({
      company_id: companyId,
    });
    if (startDate) params.append('start_date', startDate);
    if (endDate) params.append('end_date', endDate);

    return this.request<{ receipts: FreeeReceipt[] }>(
      'GET',
      `/receipts?${params}`
    ).then((result) => result.receipts);
  }

  /**
   * Create deal (取引登録)
   */
  async createDeal(
    params: FreeeDealCreateParams,
    idempotencyKey: string
  ): Promise<FreeeDealResult> {
    return this.request<FreeeDealResult>(
      'POST',
      '/deals',
      params,
      idempotencyKey
    );
  }

  /**
   * Link receipt to deal (領収書-取引紐付け)
   */
  async linkReceiptToDeal(
    receiptId: number,
    dealId: number
  ): Promise<void> {
    const companyId = await this.resolveCompanyId();
    await this.request<unknown>(
      'PUT',
      `/receipts/${receiptId}`,
      {
        company_id: parseInt(companyId, 10),
        deal_id: dealId,
      }
    );

    safeLog(this.env, 'info', 'Receipt linked to deal', {
      receiptId,
      dealId,
    });
  }
}

// =============================================================================
// Factory Function
// =============================================================================

export function createFreeeClient(env: Env): FreeeClient {
  return new FreeeClient(env);
}
