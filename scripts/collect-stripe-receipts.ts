/**
 * Stripe Dashboard Receipt Collector
 *
 * Uses Playwright to:
 * - Log into Stripe Dashboard
 * - Navigate to Payments page
 * - Collect receipt URLs
 * - Download PDFs
 * - Process through existing receipt pipeline
 */

import { chromium, type Browser, type Page } from 'playwright';
import { processAttachment } from '../src/handlers/receipt-gmail-poller';
import type { Env } from '../src/types';

interface StripeReceipt {
  id: string;
  url: string;
  date: string;
  amount: number;
  description: string;
}

/**
 * Login to Stripe Dashboard
 */
async function loginToStripe(page: Page, email: string, password: string): Promise<void> {
  console.log('[Stripe Collector] Navigating to login page');
  await page.goto('https://dashboard.stripe.com/login');

  console.log('[Stripe Collector] Entering credentials');
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', password);
  await page.click('button[type="submit"]');

  // Wait for dashboard to load
  await page.waitForURL('**/dashboard.stripe.com/**', { timeout: 30000 });
  console.log('[Stripe Collector] Login successful');
}

/**
 * Handle 2FA if required (TOTP only)
 */
async function handle2FA(page: Page, totpSecret?: string): Promise<void> {
  try {
    // Check if 2FA page is displayed
    const has2FA = await page.locator('input[name="code"]').isVisible({ timeout: 5000 });
    if (!has2FA) return;

    if (!totpSecret) {
      throw new Error('2FA required but TOTP secret not provided');
    }

    console.log('[Stripe Collector] 2FA detected, generating TOTP code');
    // TODO: Implement TOTP code generation
    // For now, manual input is required
    throw new Error('2FA detected: Please disable 2FA temporarily or implement TOTP generation');
  } catch (error) {
    if (error instanceof Error && error.message.includes('2FA')) {
      throw error;
    }
    // No 2FA page detected, continue
  }
}

/**
 * Collect receipt URLs from Payments page
 */
async function collectReceiptURLs(page: Page, daysAgo: number = 30): Promise<StripeReceipt[]> {
  console.log('[Stripe Collector] Navigating to Payments page');
  await page.goto('https://dashboard.stripe.com/payments');
  await page.waitForLoadState('networkidle');

  console.log('[Stripe Collector] Extracting receipt links');
  const receipts = await page.$$eval(
    'a[href*="/receipts/"]',
    (links, days) => {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - days);

      return links
        .map((link) => {
          const href = (link as HTMLAnchorElement).href;
          const row = link.closest('tr');
          if (!row) return null;

          const dateText = row.querySelector('[data-test-id="date"]')?.textContent || '';
          const amountText = row.querySelector('[data-test-id="amount"]')?.textContent || '0';
          const description = row.querySelector('[data-test-id="description"]')?.textContent || '';

          const date = new Date(dateText);
          if (date < cutoffDate) return null;

          return {
            id: href.split('/').pop() || '',
            url: href,
            date: date.toISOString(),
            amount: parseFloat(amountText.replace(/[^0-9.]/g, '')) || 0,
            description: description.trim(),
          };
        })
        .filter((r): r is StripeReceipt => r !== null);
    },
    daysAgo
  );

  console.log(`[Stripe Collector] Found ${receipts.length} receipts`);
  return receipts;
}

/**
 * Download receipt PDF
 */
async function downloadReceiptPDF(page: Page, receipt: StripeReceipt): Promise<Buffer> {
  console.log(`[Stripe Collector] Downloading receipt: ${receipt.id}`);
  await page.goto(receipt.url);
  await page.waitForLoadState('networkidle');

  // Generate PDF from receipt page
  const pdf = await page.pdf({
    format: 'A4',
    printBackground: true,
  });

  return Buffer.from(pdf);
}

/**
 * Main execution
 */
async function main() {
  const email = process.env.STRIPE_EMAIL;
  const password = process.env.STRIPE_PASSWORD;
  const totpSecret = process.env.STRIPE_TOTP_SECRET; // Optional

  if (!email || !password) {
    throw new Error('STRIPE_EMAIL and STRIPE_PASSWORD must be set');
  }

  const browser = await chromium.launch({
    headless: process.env.HEADLESS !== 'false',
  });

  try {
    const page = await browser.newPage();

    // Step 1: Login
    await loginToStripe(page, email, password);

    // Step 2: Handle 2FA if present
    await handle2FA(page, totpSecret);

    // Step 3: Collect receipt URLs
    const receipts = await collectReceiptURLs(page, 30); // Last 30 days

    // Step 4: Download and process each receipt
    for (const receipt of receipts) {
      try {
        const pdfBuffer = await downloadReceiptPDF(page, receipt);

        console.log(`[Stripe Collector] Processing receipt: ${receipt.id}`);

        // TODO: Integrate with existing receipt pipeline
        // This would call processAttachment() or similar
        // For now, save to local file
        const fs = await import('fs/promises');
        const outputPath = `./receipts-stripe/${receipt.id}.pdf`;
        await fs.mkdir('./receipts-stripe', { recursive: true });
        await fs.writeFile(outputPath, pdfBuffer);
        console.log(`[Stripe Collector] Saved: ${outputPath}`);
      } catch (error) {
        console.error(`[Stripe Collector] Failed to process ${receipt.id}:`, error);
      }
    }

    console.log('[Stripe Collector] Collection completed');
  } finally {
    await browser.close();
  }
}

// CLI execution
if (require.main === module) {
  main().catch((error) => {
    console.error('[Stripe Collector] Fatal error:', error);
    process.exit(1);
  });
}

export { main as collectStripeReceipts };
