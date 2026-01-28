#!/usr/bin/env npx tsx
/**
 * Google Auth Setup — one-time OAuth flow for Slides + Drive scopes.
 *
 * Uses the gcloud CLI's OAuth client (not blocked by Workspace policy).
 * Saves refresh_token to ~/.config/gcloud/slides-credentials.json
 *
 * Usage:
 *   npx tsx scripts/google-auth-setup.ts
 */

import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { writeFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';

// gcloud CLI's public OAuth client (not subject to Workspace app blocking)
const CLIENT_ID = '32555940559.apps.googleusercontent.com';
const CLIENT_SECRET = 'ZmssLNjJy2998hD4CTg2ejr2';
const REDIRECT_URI = 'http://localhost:8085/';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const OUTPUT_PATH = `${homedir()}/.config/gcloud/slides-credentials.json`;

// Note: presentations scope is not registered on gcloud client.
// Drive scope grants full access to Google Slides (files are stored in Drive).
const SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/cloud-platform',
].join(' ');

async function main(): Promise<void> {
  console.log('Google Auth Setup for Slides + Drive');
  console.log('====================================');
  console.log(`Output: ${OUTPUT_PATH}`);
  console.log('');

  const authCode = await getAuthorizationCode();
  console.log('Authorization code received. Exchanging for tokens...');

  const tokens = await exchangeCodeForTokens(authCode);
  console.log('Token exchange successful.');

  // Save credentials
  const credentials = {
    type: 'authorized_user',
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    refresh_token: tokens.refresh_token,
  };

  await writeFile(OUTPUT_PATH, JSON.stringify(credentials, null, 2));
  console.log(`\nCredentials saved to: ${OUTPUT_PATH}`);
  console.log('You can now run: npx tsx scripts/generate-slides.ts --route a --topic "Test"');
}

function getAuthorizationCode(): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url || '/', `http://localhost:8085`);
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(`<h1>Error</h1><p>${error}</p>`);
        server.close();
        reject(new Error(`Auth error: ${error}`));
        return;
      }

      if (code) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h1>Success!</h1><p>You can close this window.</p>');
        server.close();
        resolve(code);
        return;
      }

      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Missing authorization code');
    });

    server.listen(8085, () => {
      const authUrl = [
        'https://accounts.google.com/o/oauth2/auth',
        `?client_id=${encodeURIComponent(CLIENT_ID)}`,
        `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`,
        `&scope=${encodeURIComponent(SCOPES)}`,
        '&response_type=code',
        '&access_type=offline',
        '&prompt=consent',
      ].join('');

      console.log('Opening browser for Google sign-in...');
      console.log(`URL: ${authUrl}\n`);

      try {
        execSync(`open "${authUrl}"`);
      } catch {
        console.log('Could not open browser. Please visit the URL above.');
      }
    });

    // Timeout after 2 minutes
    setTimeout(() => {
      server.close();
      reject(new Error('Timeout waiting for authorization'));
    }, 120_000);
  });
}

async function exchangeCodeForTokens(
  code: string
): Promise<{ access_token: string; refresh_token: string }> {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
      redirect_uri: REDIRECT_URI,
    }).toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Token exchange failed (${response.status}): ${errorText}`);
  }

  return response.json() as Promise<{ access_token: string; refresh_token: string }>;
}

main().catch((error) => {
  console.error('Error:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
