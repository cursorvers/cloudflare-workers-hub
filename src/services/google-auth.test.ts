/**
 * Tests for Google Authentication helper.
 *
 * Covers:
 * - Credential loading (ADC + Service Account)
 * - Access token exchange (refresh_token)
 * - Project number resolution
 * - Zod schema validation
 *
 * Note: JWT signing tests use a real RSA key generated at test time.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import {
  loadGoogleCredentials,
  getAccessToken,
  resolveProjectNumber,
  authenticate,
} from './google-auth';

// ============================================================================
// Generate a real RSA key pair for JWT tests
// ============================================================================

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

// ============================================================================
// Fixtures
// ============================================================================

const MOCK_ADC = {
  type: 'authorized_user' as const,
  client_id: 'test-client-id',
  client_secret: 'test-client-secret',
  refresh_token: 'test-refresh-token',
};

const MOCK_SA = {
  type: 'service_account' as const,
  client_email: 'test@project.iam.gserviceaccount.com',
  private_key: privateKey,
  token_uri: 'https://oauth2.googleapis.com/token',
  project_id: 'test-project',
};

// ============================================================================
// loadGoogleCredentials
// ============================================================================

describe('loadGoogleCredentials', () => {
  const originalEnv = process.env.GOOGLE_CREDENTIALS_PATH;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.GOOGLE_CREDENTIALS_PATH;
    } else {
      process.env.GOOGLE_CREDENTIALS_PATH = originalEnv;
    }
  });

  it('should load ADC credentials from file', async () => {
    const { writeFile, unlink } = await import('node:fs/promises');
    const tmpPath = '/tmp/test-adc-creds.json';
    await writeFile(tmpPath, JSON.stringify(MOCK_ADC));

    try {
      const creds = await loadGoogleCredentials(tmpPath);
      expect(creds.type).toBe('authorized_user');
      if (creds.type === 'authorized_user') {
        expect(creds.client_id).toBe('test-client-id');
        expect(creds.refresh_token).toBe('test-refresh-token');
      }
    } finally {
      await unlink(tmpPath).catch(() => {});
    }
  });

  it('should load service account credentials from file', async () => {
    const { writeFile, unlink } = await import('node:fs/promises');
    const tmpPath = '/tmp/test-sa-creds.json';
    await writeFile(tmpPath, JSON.stringify(MOCK_SA));

    try {
      const creds = await loadGoogleCredentials(tmpPath);
      expect(creds.type).toBe('service_account');
      if (creds.type === 'service_account') {
        expect(creds.client_email).toBe('test@project.iam.gserviceaccount.com');
      }
    } finally {
      await unlink(tmpPath).catch(() => {});
    }
  });

  it('should prefer explicit path over defaults', async () => {
    const { writeFile, unlink } = await import('node:fs/promises');
    const tmpPath = '/tmp/test-explicit-creds.json';
    const customAdc = { ...MOCK_ADC, client_id: 'explicit-id' };
    await writeFile(tmpPath, JSON.stringify(customAdc));

    try {
      const creds = await loadGoogleCredentials(tmpPath);
      if (creds.type === 'authorized_user') {
        expect(creds.client_id).toBe('explicit-id');
      }
    } finally {
      await unlink(tmpPath).catch(() => {});
    }
  });
});

// ============================================================================
// getAccessToken
// ============================================================================

describe('getAccessToken', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('should exchange refresh token for ADC credentials', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: 'new-access-token',
        expires_in: 3600,
        token_type: 'Bearer',
      }),
    });

    const result = await getAccessToken(MOCK_ADC);

    expect(result.access_token).toBe('new-access-token');
    expect(result.expires_in).toBe(3600);
    expect(result.token_type).toBe('Bearer');

    // Verify the refresh token request
    const [url, options] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('https://oauth2.googleapis.com/token');
    expect(options.method).toBe('POST');
    expect(options.body).toContain('grant_type=refresh_token');
    expect(options.body).toContain('refresh_token=test-refresh-token');
  });

  it('should throw on failed refresh token exchange', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => 'Invalid grant',
    });

    await expect(getAccessToken(MOCK_ADC)).rejects.toThrow(/Token exchange failed/);
  });

  it('should exchange JWT for service account credentials', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: 'sa-access-token',
        expires_in: 3600,
        token_type: 'Bearer',
      }),
    });

    const result = await getAccessToken(MOCK_SA);

    expect(result.access_token).toBe('sa-access-token');

    // Verify JWT assertion was sent
    const [, options] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(options.body).toContain('grant_type=urn');
    expect(options.body).toContain('assertion=');
  });

  it('should throw on failed JWT exchange', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => 'Invalid JWT',
    });

    await expect(getAccessToken(MOCK_SA)).rejects.toThrow(/JWT token exchange failed/);
  });
});

// ============================================================================
// resolveProjectNumber
// ============================================================================

describe('resolveProjectNumber', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('should return project number on success', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ projectNumber: '123456789' }),
    });

    const result = await resolveProjectNumber('token', 'my-project');

    expect(result).toBe('123456789');
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('my-project'),
      expect.objectContaining({
        headers: { Authorization: 'Bearer token' },
      }),
    );
  });

  it('should throw on API error', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 403,
      text: async () => 'Forbidden',
    });

    await expect(
      resolveProjectNumber('token', 'bad-project'),
    ).rejects.toThrow(/Failed to resolve project number/);
  });

  it('should include project ID in error message', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: async () => 'Not found',
    });

    await expect(
      resolveProjectNumber('token', 'missing-project'),
    ).rejects.toThrow(/missing-project/);
  });
});

// ============================================================================
// authenticate (convenience)
// ============================================================================

describe('authenticate', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('should load credentials and return access token', async () => {
    const { writeFile, unlink } = await import('node:fs/promises');
    const tmpPath = '/tmp/test-auth-creds.json';
    await writeFile(tmpPath, JSON.stringify(MOCK_ADC));

    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: 'auth-token',
        expires_in: 3600,
        token_type: 'Bearer',
      }),
    });

    try {
      const result = await authenticate(tmpPath);
      expect(result.accessToken).toBe('auth-token');
      expect(result.credentials.type).toBe('authorized_user');
    } finally {
      await unlink(tmpPath).catch(() => {});
    }
  });

  it('should return both accessToken and credentials', async () => {
    const { writeFile, unlink } = await import('node:fs/promises');
    const tmpPath = '/tmp/test-auth-both.json';
    await writeFile(tmpPath, JSON.stringify(MOCK_SA));

    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: 'sa-auth-token',
        expires_in: 3600,
        token_type: 'Bearer',
      }),
    });

    try {
      const result = await authenticate(tmpPath);
      expect(result.accessToken).toBe('sa-auth-token');
      expect(result.credentials.type).toBe('service_account');
      if (result.credentials.type === 'service_account') {
        expect(result.credentials.client_email).toBe('test@project.iam.gserviceaccount.com');
      }
    } finally {
      await unlink(tmpPath).catch(() => {});
    }
  });
});
