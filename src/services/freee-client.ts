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
// Types
// =============================================================================

export interface FreeeConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
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

// =============================================================================
// OAuth Token Management
// =============================================================================

/**
 * Encrypt refresh token with AES-GCM
 */
async function encryptToken(token: string, key: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(token);
  const keyData = encoder.encode(key.padEnd(32, '0').slice(0, 32));

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'AES-GCM' },
    false,
    ['encrypt']
  );

  const iv = crypto.getRandomValues(new Uint8Array(12));
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
  const keyData = encoder.encode(key.padEnd(32, '0').slice(0, 32));

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
  const iv = combined.slice(0, 12);
  const data = combined.slice(12);

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

export class FreeeClient {
  private env: Env;
  private config: FreeeConfig;
  private baseUrl = 'https://api.freee.co.jp/api/1';

  constructor(env: Env) {
    this.env = env;
    this.config = {
      clientId: env.FREEE_CLIENT_ID,
      clientSecret: env.FREEE_CLIENT_SECRET,
      redirectUri: env.FREEE_REDIRECT_URI,
      companyId: env.FREEE_COMPANY_ID,
    };
  }

  /**
   * Get valid access token (refresh if expired)
   */
  private async getAccessToken(): Promise<string> {
    // Get encrypted refresh token from KV
    const encryptedRefreshToken = await this.env.KV.get('freee:refresh_token');
    if (!encryptedRefreshToken) {
      throw new Error('No refresh token found. Please authenticate first.');
    }

    // Check if access token is still valid
    const accessTokenExpiry = await this.env.KV.get('freee:access_token_expiry');
    const accessToken = await this.env.KV.get('freee:access_token');

    if (
      accessToken &&
      accessTokenExpiry &&
      Date.now() < parseInt(accessTokenExpiry)
    ) {
      return accessToken;
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
    await this.env.KV.put('freee:access_token', tokens.access_token, {
      expirationTtl: tokens.expires_in - 60, // Refresh 1 min before expiry
    });
    await this.env.KV.put(
      'freee:access_token_expiry',
      (Date.now() + (tokens.expires_in - 60) * 1000).toString()
    );

    // Encrypt and store new refresh token
    const encryptedNewRefreshToken = await encryptToken(
      tokens.refresh_token,
      this.env.FREEE_ENCRYPTION_KEY
    );
    await this.env.KV.put('freee:refresh_token', encryptedNewRefreshToken);

    safeLog(this.env, 'info', 'Access token refreshed', {});

    return tokens.access_token;
  }

  /**
   * Exponential backoff retry
   */
  private async retryWithBackoff<T>(
    fn: () => Promise<T>,
    maxRetries = 3
  ): Promise<T> {
    let attempt = 0;
    while (attempt < maxRetries) {
      try {
        return await fn();
      } catch (error: any) {
        attempt++;
        if (attempt >= maxRetries) {
          throw error;
        }

        // Check if rate limited (429)
        if (error.status === 429) {
          const retryAfter = error.headers?.get('Retry-After');
          const waitTime = retryAfter
            ? parseInt(retryAfter) * 1000
            : Math.pow(2, attempt) * 1000;

          safeLog(this.env, 'warn', 'Rate limited, retrying', {
            attempt,
            waitTime,
          });

          await new Promise((resolve) => setTimeout(resolve, waitTime));
        } else {
          // Exponential backoff for other errors
          const waitTime = Math.pow(2, attempt) * 1000;
          await new Promise((resolve) => setTimeout(resolve, waitTime));
        }
      }
    }
    throw new Error('Max retries exceeded');
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
      const formData = new FormData();
      formData.append('receipt', file, fileName);
      formData.append('company_id', this.config.companyId);

      const response = await fetch(`${this.baseUrl}/receipts`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'X-Idempotency-Key': idempotencyKey, // Prevent duplicate uploads
        },
        body: formData,
      });

      if (!response.ok) {
        const error: any = new Error(`freee API error: ${response.statusText}`);
        error.status = response.status;
        error.headers = response.headers;
        throw error;
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
    const accessToken = await this.getAccessToken();

    return this.retryWithBackoff(async () => {
      const response = await fetch(
        `${this.baseUrl}/receipts/${receiptId}?company_id=${this.config.companyId}`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        }
      );

      if (!response.ok) {
        throw new Error(`freee API error: ${response.statusText}`);
      }

      const result: { receipt: FreeeReceipt } = await response.json();
      return result.receipt;
    });
  }

  /**
   * List receipts
   */
  async listReceipts(
    startDate?: string,
    endDate?: string
  ): Promise<FreeeReceipt[]> {
    const accessToken = await this.getAccessToken();

    return this.retryWithBackoff(async () => {
      const params = new URLSearchParams({
        company_id: this.config.companyId,
      });
      if (startDate) params.append('start_date', startDate);
      if (endDate) params.append('end_date', endDate);

      const response = await fetch(`${this.baseUrl}/receipts?${params}`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      if (!response.ok) {
        throw new Error(`freee API error: ${response.statusText}`);
      }

      const result: { receipts: FreeeReceipt[] } = await response.json();
      return result.receipts;
    });
  }
}

// =============================================================================
// Factory Function
// =============================================================================

export function createFreeeClient(env: Env): FreeeClient {
  return new FreeeClient(env);
}
