#!/usr/bin/env node
/**
 * Stripe Invoice Fetcher
 *
 * Fetches invoices from Stripe API and uploads to Workers API.
 * Uses Stripe API directly instead of web scraping to avoid CAPTCHA issues.
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// Configuration
// ============================================================================

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const WORKERS_API_URL = process.env.WORKERS_API_URL || 'https://orchestrator-hub.masa-stage1.workers.dev';
const WORKERS_API_KEY = process.env.WORKERS_API_KEY;
const DOWNLOADS_DIR = path.join(__dirname, '../downloads');

// ============================================================================
// Stripe API Client
// ============================================================================

async function stripeRequest(endpoint, options = {}) {
  const url = `https://api.stripe.com/v1${endpoint}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      ...options.headers,
    },
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(`Stripe API error: ${error.error?.message || response.statusText}`);
  }

  return response.json();
}

/**
 * List invoices from Stripe.
 */
async function listInvoices(options = {}) {
  const params = [];

  if (options.limit) params.push(`limit=${options.limit}`);
  if (options.status) params.push(`status=${options.status}`);
  if (options.created_gte) params.push(`created[gte]=${options.created_gte}`);
  if (options.created_lte) params.push(`created[lte]=${options.created_lte}`);

  const query = params.join('&');
  const endpoint = `/invoices${query ? `?${query}` : ''}`;

  return stripeRequest(endpoint);
}

/**
 * Download invoice PDF.
 */
async function downloadInvoicePdf(invoice) {
  if (!invoice.invoice_pdf) {
    console.log(`[stripe] Invoice ${invoice.id} has no PDF URL`);
    return null;
  }

  const response = await fetch(invoice.invoice_pdf);
  if (!response.ok) {
    throw new Error(`Failed to download PDF: ${response.statusText}`);
  }

  const buffer = await response.arrayBuffer();
  const fileName = `stripe-invoice-${invoice.number || invoice.id}-${Date.now()}.pdf`;
  const filePath = path.join(DOWNLOADS_DIR, fileName);

  await fs.writeFile(filePath, Buffer.from(buffer));
  console.log(`[stripe] Downloaded: ${filePath}`);

  return filePath;
}

/**
 * Upload file to Workers API.
 */
async function uploadToWorkers(filePath, metadata = {}) {
  if (!WORKERS_API_KEY) {
    console.warn('[stripe] WORKERS_API_KEY not set, skipping upload');
    return null;
  }

  const fileBuffer = await fs.readFile(filePath);
  const fileName = path.basename(filePath);

  const formData = new FormData();
  formData.append('file', new Blob([fileBuffer], { type: 'application/pdf' }), fileName);
  formData.append('source', 'stripe');
  formData.append('metadata', JSON.stringify(metadata));

  const uploadUrl = `${WORKERS_API_URL}/api/receipts/upload`;

  const response = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'X-API-Key': WORKERS_API_KEY,
    },
    body: formData,
  });

  if (!response.ok) {
    throw new Error(`Upload failed: ${response.status} ${await response.text()}`);
  }

  const result = await response.json();
  console.log(`[stripe] Uploaded to Workers:`, result);
  return result;
}

/**
 * Get date range for filtering.
 */
function getDateRange(range) {
  const now = new Date();

  switch (range) {
    case 'last_month': {
      const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0);
      return {
        created_gte: Math.floor(lastMonth.getTime() / 1000),
        created_lte: Math.floor(endOfLastMonth.getTime() / 1000),
      };
    }
    case 'this_month': {
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      return {
        created_gte: Math.floor(startOfMonth.getTime() / 1000),
      };
    }
    case 'last_90_days': {
      const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
      return {
        created_gte: Math.floor(ninetyDaysAgo.getTime() / 1000),
      };
    }
    default:
      return {};
  }
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const args = process.argv.slice(2);
  const rangeArg = args.find((arg) => arg.startsWith('--range='))?.split('=')[1] || 'last_month';
  const limitArg = parseInt(args.find((arg) => arg.startsWith('--limit='))?.split('=')[1] || '10', 10);
  const dryRun = args.includes('--dry-run');

  console.log('Stripe Invoice Fetcher');
  console.log('======================');
  console.log(`Date range: ${rangeArg}`);
  console.log(`Limit: ${limitArg}`);
  console.log(`Dry run: ${dryRun}`);
  console.log(`Workers API: ${WORKERS_API_URL}`);

  // Validate configuration
  if (!STRIPE_SECRET_KEY) {
    console.error('Error: STRIPE_SECRET_KEY environment variable is required');
    process.exit(1);
  }

  // Ensure download directory exists
  await fs.mkdir(DOWNLOADS_DIR, { recursive: true });

  // Get date range
  const dateRange = getDateRange(rangeArg);
  console.log(`\nFetching invoices...`);

  // List invoices
  const invoicesResponse = await listInvoices({
    limit: limitArg,
    status: 'paid',
    ...dateRange,
  });

  const invoices = invoicesResponse.data || [];
  console.log(`Found ${invoices.length} paid invoices`);

  if (invoices.length === 0) {
    console.log('No invoices to process');
    return;
  }

  // Process each invoice
  const results = { success: 0, failed: 0, skipped: 0 };

  for (const invoice of invoices) {
    console.log(`\n[stripe] Processing invoice ${invoice.number || invoice.id}`);
    console.log(`  - Amount: ${(invoice.amount_paid / 100).toFixed(2)} ${invoice.currency.toUpperCase()}`);
    console.log(`  - Date: ${new Date(invoice.created * 1000).toISOString().split('T')[0]}`);
    console.log(`  - Status: ${invoice.status}`);

    if (dryRun) {
      console.log(`  - [DRY RUN] Would download and upload`);
      results.skipped++;
      continue;
    }

    try {
      // Download PDF
      const filePath = await downloadInvoicePdf(invoice);
      if (!filePath) {
        results.skipped++;
        continue;
      }

      // Upload to Workers
      await uploadToWorkers(filePath, {
        invoiceId: invoice.id,
        invoiceNumber: invoice.number,
        amount: invoice.amount_paid,
        currency: invoice.currency,
        date: new Date(invoice.created * 1000).toISOString(),
      });

      // Clean up
      await fs.unlink(filePath);
      console.log(`  - Cleaned up: ${filePath}`);

      results.success++;
    } catch (error) {
      console.error(`  - Error: ${error.message}`);
      results.failed++;
    }
  }

  // Summary
  console.log('\n======================');
  console.log('Summary:');
  console.log(`  Success: ${results.success}`);
  console.log(`  Failed: ${results.failed}`);
  console.log(`  Skipped: ${results.skipped}`);

  if (results.failed > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
