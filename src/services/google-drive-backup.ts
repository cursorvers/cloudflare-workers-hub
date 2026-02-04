/**
 * Google Drive Backup Service
 *
 * Save freee API responses to Google Drive for audit and backup purposes.
 * Uses Gmail OAuth credentials (GMAIL_CLIENT_ID/SECRET/REFRESH_TOKEN).
 */

import { z } from 'zod';
import type { Env } from '../types';

// ============================================================================
// Schemas
// ============================================================================

const TokenResponseSchema = z.object({
  access_token: z.string(),
  expires_in: z.number(),
  token_type: z.string(),
});

const DriveFileResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  mimeType: z.string(),
  webViewLink: z.string().optional(),
});

const FolderSearchResponseSchema = z.object({
  files: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
    })
  ),
});

// ============================================================================
// Constants
// ============================================================================

const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GOOGLE_DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';
const GOOGLE_DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3/files';

const DRIVE_SCOPES = [
  'https://www.googleapis.com/auth/drive.file', // Create and access own files
].join(' ');

// ============================================================================
// Types
// ============================================================================

export interface FreeeReceiptBackup {
  receiptId: string;
  freeeReceiptId: string | null;
  transactionDate: string;
  vendorName: string;
  amount: number;
  currency: string;
  status: string;
  createdAt: string;
  freeeApiResponse?: unknown; // Full freee API response
}

// ============================================================================
// Token Management
// ============================================================================

/**
 * Refresh access token using Gmail OAuth credentials.
 */
async function refreshAccessToken(env: Env): Promise<string> {
  const response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      client_id: env.GMAIL_CLIENT_ID!,
      client_secret: env.GMAIL_CLIENT_SECRET!,
      refresh_token: env.GMAIL_REFRESH_TOKEN!,
      grant_type: 'refresh_token',
      scope: DRIVE_SCOPES,
    }).toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to refresh Google token: ${response.status} ${errorText}`);
  }

  const data = await response.json();
  const parsed = TokenResponseSchema.parse(data);
  return parsed.access_token;
}

// ============================================================================
// Google Drive API Methods
// ============================================================================

/**
 * Find or create a folder by path.
 * Path format: "freee-receipts/2026/02"
 */
async function ensureFolderPath(
  accessToken: string,
  path: string
): Promise<string> {
  const parts = path.split('/').filter((p) => p.length > 0);
  let parentId = 'root';

  for (const folderName of parts) {
    const folderId = await findOrCreateFolder(accessToken, folderName, parentId);
    parentId = folderId;
  }

  return parentId;
}

/**
 * Find or create a folder.
 */
async function findOrCreateFolder(
  accessToken: string,
  folderName: string,
  parentId: string
): Promise<string> {
  // Search for existing folder
  const searchUrl = `${GOOGLE_DRIVE_API_BASE}/files?` +
    new URLSearchParams({
      q: `name='${folderName}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: 'files(id, name)',
    }).toString();

  const searchResponse = await fetch(searchUrl, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });

  if (!searchResponse.ok) {
    throw new Error(`Failed to search folder: ${searchResponse.status}`);
  }

  const searchData = await searchResponse.json();
  const parsed = FolderSearchResponseSchema.parse(searchData);

  if (parsed.files.length > 0) {
    return parsed.files[0].id;
  }

  // Create new folder
  const createResponse = await fetch(`${GOOGLE_DRIVE_API_BASE}/files`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId],
    }),
  });

  if (!createResponse.ok) {
    throw new Error(`Failed to create folder: ${createResponse.status}`);
  }

  const createData = await createResponse.json();
  const folder = DriveFileResponseSchema.parse(createData);
  return folder.id;
}

/**
 * Upload a file to Google Drive.
 */
async function uploadFile(
  accessToken: string,
  folderId: string,
  fileName: string,
  content: string,
  mimeType: string
): Promise<string> {
  const metadata = {
    name: fileName,
    parents: [folderId],
    mimeType,
  };

  const boundary = '-------314159265358979323846';
  const delimiter = `\r\n--${boundary}\r\n`;
  const closeDelimiter = `\r\n--${boundary}--`;

  const multipartBody =
    delimiter +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    JSON.stringify(metadata) +
    delimiter +
    `Content-Type: ${mimeType}\r\n\r\n` +
    content +
    closeDelimiter;

  const response = await fetch(
    `${GOOGLE_DRIVE_UPLOAD_API}?uploadType=multipart`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body: multipartBody,
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to upload file: ${response.status} ${errorText}`);
  }

  const data = await response.json();
  const file = DriveFileResponseSchema.parse(data);
  return file.id;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Backup freee receipt data to Google Drive.
 *
 * @param env - Cloudflare Workers environment
 * @param backup - Receipt backup data
 * @returns Google Drive file ID
 */
export async function backupToGoogleDrive(
  env: Env,
  backup: FreeeReceiptBackup
): Promise<{ fileId: string; webViewLink?: string }> {
  // Validate credentials
  if (!env.GMAIL_CLIENT_ID || !env.GMAIL_CLIENT_SECRET || !env.GMAIL_REFRESH_TOKEN) {
    throw new Error('Gmail OAuth credentials not configured');
  }

  // Refresh access token
  const accessToken = await refreshAccessToken(env);

  // Build folder path: freee-receipts/YYYY/MM
  const date = new Date(backup.transactionDate);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const folderPath = `freee-receipts/${year}/${month}`;

  // Ensure folder exists
  const folderId = await ensureFolderPath(accessToken, folderPath);

  // Build file name: YYYY-MM-DD-{receiptId}.json
  const day = String(date.getDate()).padStart(2, '0');
  const fileName = `${year}-${month}-${day}-${backup.receiptId}.json`;

  // Prepare JSON content
  const jsonContent = JSON.stringify(backup, null, 2);

  // Upload file
  const fileId = await uploadFile(
    accessToken,
    folderId,
    fileName,
    jsonContent,
    'application/json'
  );

  // Get web view link
  const fileUrl = `${GOOGLE_DRIVE_API_BASE}/files/${fileId}?fields=webViewLink`;
  const fileResponse = await fetch(fileUrl, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });

  let webViewLink: string | undefined;
  if (fileResponse.ok) {
    const fileData = await fileResponse.json();
    const file = DriveFileResponseSchema.parse(fileData);
    webViewLink = file.webViewLink;
  }

  return { fileId, webViewLink };
}

/**
 * List recent backups from Google Drive.
 *
 * @param env - Cloudflare Workers environment
 * @param limit - Maximum number of files to return
 * @returns Array of backup file metadata
 */
export async function listRecentBackups(
  env: Env,
  limit: number = 10
): Promise<Array<{ id: string; name: string; webViewLink?: string }>> {
  if (!env.GMAIL_CLIENT_ID || !env.GMAIL_CLIENT_SECRET || !env.GMAIL_REFRESH_TOKEN) {
    throw new Error('Gmail OAuth credentials not configured');
  }

  const accessToken = await refreshAccessToken(env);

  const searchUrl = `${GOOGLE_DRIVE_API_BASE}/files?` +
    new URLSearchParams({
      q: "name contains '.json' and trashed=false",
      orderBy: 'createdTime desc',
      pageSize: limit.toString(),
      fields: 'files(id, name, webViewLink)',
    }).toString();

  const response = await fetch(searchUrl, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to list backups: ${response.status}`);
  }

  const data = await response.json();
  const parsed = FolderSearchResponseSchema.parse(data);
  return parsed.files.map((f: any) => ({
    id: f.id,
    name: f.name,
    webViewLink: f.webViewLink,
  }));
}
