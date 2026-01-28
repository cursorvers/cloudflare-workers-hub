/**
 * Google Authentication Helper
 *
 * Shared authentication for Google APIs (Slides, NotebookLM Enterprise).
 * Uses Application Default Credentials (ADC) from gcloud CLI.
 *
 * No npm dependencies — fetch-based, Zod validation.
 */

import { z } from 'zod';

// ============================================================================
// Schemas
// ============================================================================

const GoogleCredentialsSchema = z.object({
  client_id: z.string().min(1),
  client_secret: z.string().min(1),
  refresh_token: z.string().min(1),
  type: z.string().optional(),
});

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
const DEFAULT_CREDENTIALS_PATH = `${process.env.HOME}/.config/gcloud/application_default_credentials.json`;

// ============================================================================
// Public API
// ============================================================================

/**
 * Load Google credentials from ADC file.
 *
 * @param credentialsPath - Path to credentials JSON (defaults to gcloud ADC)
 * @returns Validated Google credentials
 */
export async function loadGoogleCredentials(
  credentialsPath?: string
): Promise<GoogleCredentials> {
  const filePath = credentialsPath || DEFAULT_CREDENTIALS_PATH;

  const { readFile } = await import('node:fs/promises');

  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch (error) {
    throw new Error(
      `Failed to read Google credentials from ${filePath}: ${String(error)}. ` +
      'Run "gcloud auth application-default login" to create credentials.'
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON in credentials file: ${filePath}`);
  }

  return GoogleCredentialsSchema.parse(parsed);
}

/**
 * Exchange refresh_token for a short-lived access_token.
 *
 * @param credentials - Google credentials with refresh_token
 * @returns Access token response
 */
export async function getAccessToken(
  credentials: GoogleCredentials
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    client_id: credentials.client_id,
    client_secret: credentials.client_secret,
    refresh_token: credentials.refresh_token,
    grant_type: 'refresh_token',
  });

  const response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
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

/**
 * Resolve a GCP project ID to its numeric project number.
 * Required by NotebookLM Enterprise API.
 *
 * @param accessToken - Valid Google access token
 * @param projectId - GCP project ID (e.g., "my-project-123")
 * @returns Numeric project number as string
 */
export async function resolveProjectNumber(
  accessToken: string,
  projectId: string
): Promise<string> {
  const response = await fetch(`${GOOGLE_CLOUDRESOURCEMANAGER_API}/${projectId}`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
    },
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
 *
 * @param credentialsPath - Optional path to credentials JSON
 * @returns Object with accessToken and credentials
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
