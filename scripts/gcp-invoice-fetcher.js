#!/usr/bin/env node
/**
 * GCP Invoice Fetcher
 *
 * Fetches invoices from Google Cloud Billing API and uploads to Workers API.
 * Uses Service Account credentials (no browser automation).
 *
 * Required env vars:
 *   GOOGLE_APPLICATION_CREDENTIALS  - Path to service account JSON key
 *   GCP_BILLING_ACCOUNT_ID          - Billing account ID (format: 01XXXX-XXXXXX-XXXXXX)
 *   WORKERS_API_URL                 - Workers API endpoint
 *   WORKERS_API_KEY                 - Workers API key
 *
 * Required APIs:
 *   - Cloud Billing API (cloudbilling.googleapis.com)
 *   - Cloud Billing Budget API (optional)
 *
 * Required IAM Roles:
 *   - roles/billing.viewer (on billing account)
 */

import fs from 'fs/promises';

const WORKERS_API_URL = process.env.WORKERS_API_URL || 'https://orchestrator-hub.masa-stage1.workers.dev';
const WORKERS_API_KEY = process.env.WORKERS_API_KEY;
const GCP_BILLING_ACCOUNT_ID = process.env.GCP_BILLING_ACCOUNT_ID;

/**
 * Get OAuth2 access token from service account credentials.
 */
async function getAccessToken() {
  const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!credPath) {
    throw new Error('GOOGLE_APPLICATION_CREDENTIALS not set');
  }

  const cred = JSON.parse(await fs.readFile(credPath, 'utf-8'));

  // Create JWT for token exchange
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: cred.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-billing.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })).toString('base64url');

  // Sign with private key (requires crypto)
  const { createSign } = await import('crypto');
  const sign = createSign('RSA-SHA256');
  sign.update(`${header}.${payload}`);
  const signature = sign.sign(cred.private_key, 'base64url');

  const jwt = `${header}.${payload}.${signature}`;

  // Exchange JWT for access token
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });

  if (!response.ok) {
    throw new Error(`Token exchange failed: ${response.status} ${await response.text()}`);
  }

  const { access_token } = await response.json();
  return access_token;
}

/**
 * List invoices from Cloud Billing API.
 */
async function listInvoices(accessToken, billingAccountId) {
  const url = `https://cloudbilling.googleapis.com/v1/billingAccounts/${billingAccountId}/invoices`;

  const response = await fetch(url, {
    headers: { 'Authorization': `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Cloud Billing API error: ${response.status} ${errorText}`);
  }

  return response.json();
}

/**
 * Download invoice PDF.
 */
async function downloadInvoicePdf(accessToken, invoiceUrl) {
  const response = await fetch(invoiceUrl, {
    headers: { 'Authorization': `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    throw new Error(`PDF download failed: ${response.status}`);
  }

  return response.arrayBuffer();
}

/**
 * Upload to Workers API.
 */
async function uploadToWorkers(pdfBuffer, metadata = {}) {
  if (!WORKERS_API_KEY) {
    console.warn('[gcp] WORKERS_API_KEY not set, skipping upload');
    return null;
  }

  const fileName = metadata.fileName || `gcp-invoice-${Date.now()}.pdf`;

  const formData = new FormData();
  formData.append('file', new Blob([pdfBuffer], { type: 'application/pdf' }), fileName);
  formData.append('source', 'gcp');
  formData.append('vendor_name', 'Google Cloud Platform');
  formData.append('transaction_date', metadata.invoiceDate || new Date().toISOString().slice(0, 10));
  formData.append('amount', String(metadata.amount || 0));
  formData.append('currency', metadata.currency || 'USD');
  formData.append('document_type', 'invoice');
  formData.append('metadata', JSON.stringify(metadata));

  const response = await fetch(`${WORKERS_API_URL}/api/receipts/upload`, {
    method: 'POST',
    headers: { 'X-API-Key': WORKERS_API_KEY },
    body: formData,
  });

  if (!response.ok) {
    throw new Error(`Upload failed: ${response.status} ${await response.text()}`);
  }

  return response.json();
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');

  console.log('GCP Invoice Fetcher');
  console.log('===================');
  console.log(`Billing Account: ${GCP_BILLING_ACCOUNT_ID || '(not set)'}`);
  console.log(`Workers API: ${WORKERS_API_URL}`);
  console.log(`Dry run: ${dryRun}`);

  if (!GCP_BILLING_ACCOUNT_ID) {
    console.error('Error: GCP_BILLING_ACCOUNT_ID is required');
    console.error('');
    console.error('Setup steps:');
    console.error('  1. Enable Cloud Billing API');
    console.error('  2. Create service account with billing.viewer role');
    console.error('  3. Set GOOGLE_APPLICATION_CREDENTIALS and GCP_BILLING_ACCOUNT_ID');
    process.exit(1);
  }

  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    console.error('Error: GOOGLE_APPLICATION_CREDENTIALS not set');
    process.exit(1);
  }

  try {
    console.log('\nObtaining access token...');
    const accessToken = await getAccessToken();

    if (dryRun) {
      console.log('[DRY RUN] Would fetch and upload GCP invoices');
      return;
    }

    console.log('Listing invoices...');
    const invoicesResponse = await listInvoices(accessToken, GCP_BILLING_ACCOUNT_ID);
    const invoices = invoicesResponse.invoices || [];
    console.log(`Found ${invoices.length} invoices`);

    let success = 0;
    let failed = 0;

    for (const invoice of invoices.slice(0, 10)) {
      console.log(`\n[gcp] Processing invoice: ${invoice.name || invoice.invoiceId}`);

      try {
        if (invoice.pdfUrl) {
          const pdfBuffer = await downloadInvoicePdf(accessToken, invoice.pdfUrl);
          await uploadToWorkers(pdfBuffer, {
            invoiceId: invoice.invoiceId,
            invoiceDate: invoice.invoiceDate,
            amount: invoice.amount?.units || 0,
            currency: invoice.amount?.currencyCode || 'USD',
            fileName: `gcp-invoice-${invoice.invoiceId}.pdf`,
          });
          success++;
        } else {
          console.log('[gcp] No PDF URL, skipping');
        }
      } catch (error) {
        console.error(`[gcp] Error: ${error.message}`);
        failed++;
      }
    }

    console.log('\n===================');
    console.log(`Success: ${success}`);
    console.log(`Failed: ${failed}`);

    if (failed > 0) process.exit(1);
  } catch (error) {
    console.error('[gcp] Fatal error:', error.message);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
