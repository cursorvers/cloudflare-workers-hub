/**
 * Google Authentication Helper
 *
 * Shared authentication for Google APIs (Slides, NotebookLM Enterprise).
 * Supports two credential types:
 * - Service Account (JWT-based) — recommended
 * - Application Default Credentials (ADC) — fallback
 *
 * No npm dependencies — fetch-based, Zod validation, Node.js crypto.
 */

import { z } from 'zod';

// ============================================================================
// Schemas
// ============================================================================

/** ADC (authorized_user) credentials */
const ADCCredentialsSchema = z.object({
  type: z.literal('authorized_user'),
  client_id: z.string().min(1),
  client_secret: z.string().min(1),
  refresh_token: z.string().min(1),
});

/** Service Account credentials */
const ServiceAccountCredentialsSchema = z.object({
  type: z.literal('service_account'),
  client_email: z.string().email(),
  private_key: z.string().min(1),
  token_uri: z.string().url().optional(),
  project_id: z.string().optional(),
});

/** Union of supported credential types */
const GoogleCredentialsSchema = z.discriminatedUnion('type', [
  ADCCredentialsSchema,
  ServiceAccountCredentialsSchema,
]);

export type GoogleCredentials = z.infer<typeof GoogleCredentialsSchema>;

const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number(),
  token_type: z.string(),
});

export type TokenResponse = z.infer<typeof TokenResponseSchema>;

const ProjectInfoSchema = z.object({
  projectNumber: z.string().min(1),
});

// ============================================================================
// Constants
// ============================================================================

const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GOOGLE_CLOUDRESOURCEMANAGER_API = 'https://cloudresourcemanager.googleapis.com/v1/projects';

/** Default scopes for Slides + Drive (sharing) + Calendar (read-only) + Gmail (read-only) */
const DEFAULT_SCOPES = [
  'https://www.googleapis.com/auth/presentations',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/gmail.readonly',
].join(' ');

// ============================================================================
// Public API
// ============================================================================

/**
 * Load Google credentials from a JSON file.
 * Auto-detects credential type (service_account or authorized_user).
 *
 * Search order:
 * 1. Explicit credentialsPath
 * 2. GOOGLE_CREDENTIALS_PATH env
 * 3. Service account key (~/.config/gcloud/slides-generator-key.json)
 * 4. ADC (~/.config/gcloud/application_default_credentials.json)
 */
export async function loadGoogleCredentials(
  credentialsPath?: string
): Promise<GoogleCredentials> {
  // This helper is primarily for local/dev usage (file I/O). In Workers you should
  // build credentials from env vars (authorized_user refresh token flow).
  const { readFile, access } = await import('node:fs/promises');
  const googleCredentialsPath = (globalThis as any)?.process?.env?.GOOGLE_CREDENTIALS_PATH as string | undefined;

  let defaults: string[] = [];
  try {
    const { homedir } = await import('node:os');
    const home = homedir();
    defaults = [
      `${home}/.config/gcloud/slides-credentials.json`,
      `${home}/.config/gcloud/slides-generator-key.json`,
      `${home}/.config/gcloud/application_default_credentials.json`,
    ];
  } catch {
    defaults = [];
  }

  const candidates = [
    credentialsPath,
    googleCredentialsPath,
    ...defaults,
  ].filter((p): p is string => !!p);

  for (const filePath of candidates) {
    try {
      await access(filePath);
    } catch {
      continue;
    }

    let raw: string;
    try {
      raw = await readFile(filePath, 'utf-8');
    } catch {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }

    const result = GoogleCredentialsSchema.safeParse(parsed);
    if (result.success) {
      return result.data;
    }
  }

  throw new Error(
    `No valid Google credentials found. Searched: ${candidates.join(', ')}. ` +
    'Provide a service account key or run "gcloud auth application-default login".'
  );
}

/**
 * Get an access token from credentials.
 * Routes to JWT flow (service account) or refresh_token flow (ADC).
 *
 * @param credentials - Google credentials
 * @param scopes - OAuth scopes (optional)
 * @param subject - Email address to impersonate for Domain-Wide Delegation (optional)
 */
export async function getAccessToken(
  credentials: GoogleCredentials,
  scopes?: string,
  subject?: string
): Promise<TokenResponse> {
  if (credentials.type === 'service_account') {
    return getAccessTokenViaJWT(credentials, scopes || DEFAULT_SCOPES, subject);
  }
  return getAccessTokenViaRefresh(credentials);
}

/**
 * Resolve a GCP project ID to its numeric project number.
 * Required by NotebookLM Enterprise API.
 */
export async function resolveProjectNumber(
  accessToken: string,
  projectId: string
): Promise<string> {
  const response = await fetch(`${GOOGLE_CLOUDRESOURCEMANAGER_API}/${projectId}`, {
    method: 'GET',
    headers: { 'Authorization': `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Failed to resolve project number for "${projectId}" (${response.status}): ${errorText.substring(0, 200)}`
    );
  }

  const data = await response.json();
  const { projectNumber } = ProjectInfoSchema.parse(data);
  return projectNumber;
}

/**
 * Convenience: load credentials and get a fresh access token in one call.
 */
export async function authenticate(
  credentialsPath?: string
): Promise<{ accessToken: string; credentials: GoogleCredentials }> {
  const credentials = await loadGoogleCredentials(credentialsPath);
  const tokenResponse = await getAccessToken(credentials);
  return {
    accessToken: tokenResponse.access_token,
    credentials,
  };
}

// ============================================================================
// Service Account JWT Flow
// ============================================================================

/**
 * Create a signed JWT and exchange it for an access token.
 * Standard Google Service Account OAuth 2.0 flow.
 *
 * @param credentials - Service Account credentials
 * @param scopes - OAuth scopes
 * @param subject - (Optional) Email address to impersonate (for Domain-Wide Delegation)
 */
async function getAccessTokenViaJWT(
  credentials: z.infer<typeof ServiceAccountCredentialsSchema>,
  scopes: string,
  subject?: string
): Promise<TokenResponse> {
  const now = Math.floor(Date.now() / 1000);

  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payloadData: Record<string, string | number> = {
    iss: credentials.client_email,
    scope: scopes,
    aud: GOOGLE_TOKEN_ENDPOINT,
    iat: now,
    exp: now + 3600,
  };

  // Domain-Wide Delegation: impersonate user
  if (subject) {
    payloadData.sub = subject;
  }

  const payload = base64url(JSON.stringify(payloadData));

  const signatureInput = `${header}.${payload}`;
  const signatureBytes = await signRs256(credentials.private_key, signatureInput);
  const signature = base64urlFromBytes(signatureBytes);

  const jwt = `${signatureInput}.${signature}`;

  const response = await fetch(credentials.token_uri || GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }).toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `JWT token exchange failed (${response.status}): ${errorText.substring(0, 300)}`
    );
  }

  const data = await response.json();
  return TokenResponseSchema.parse(data);
}

// ============================================================================
// ADC Refresh Token Flow
// ============================================================================

/**
 * Exchange refresh_token for a short-lived access_token.
 */
async function getAccessTokenViaRefresh(
  credentials: z.infer<typeof ADCCredentialsSchema>
): Promise<TokenResponse> {
  const response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: credentials.client_id,
      client_secret: credentials.client_secret,
      refresh_token: credentials.refresh_token,
      grant_type: 'refresh_token',
    }).toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Token exchange failed (${response.status}): ${errorText.substring(0, 200)}`
    );
  }

  const data = await response.json();
  return TokenResponseSchema.parse(data);
}

// ============================================================================
// Helpers
// ============================================================================

/** Base64URL encode (no padding) */
function base64url(input: string): string {
  return base64urlFromBytes(new TextEncoder().encode(input));
}

function base64urlFromBytes(bytes: Uint8Array): string {
  // Avoid Buffer. This works in Workers and Node.
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  const base64 = btoa(binary);
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function pemToDerBytes(pem: string): Uint8Array {
  const b64 = pem
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '');
  const raw = atob(b64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

async function signRs256(privateKeyPem: string, data: string): Promise<Uint8Array> {
  const keyData = pemToDerBytes(privateKeyPem);
  const keyBuf = new ArrayBuffer(keyData.byteLength);
  new Uint8Array(keyBuf).set(keyData);
  const key = await crypto.subtle.importKey(
    'pkcs8',
    keyBuf,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(data));
  return new Uint8Array(sig);
}
