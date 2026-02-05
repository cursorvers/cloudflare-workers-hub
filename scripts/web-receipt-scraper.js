#!/usr/bin/env node
/**
 * Web Receipt Scraper
 *
 * Download receipts from various websites using Playwright.
 * Uploads to Cloudflare Workers API for processing.
 */

import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// Configuration
// ============================================================================

const CONFIG_PATH = path.join(__dirname, '../config/web-receipt-sources.json');
const WORKERS_API_URL = process.env.WORKERS_API_URL || 'https://orchestrator-hub.masa-stage1.workers.dev';
const WORKERS_API_KEY = process.env.WORKERS_API_KEY;
const SCREENSHOTS_DIR = path.join(__dirname, '../screenshots');
const DOWNLOADS_DIR = path.join(__dirname, '../downloads');

// ============================================================================
// Helpers
// ============================================================================

/**
 * Load configuration from JSON file.
 */
async function loadConfig() {
  const raw = await fs.readFile(CONFIG_PATH, 'utf-8');
  return JSON.parse(raw);
}

/**
 * Get credentials from environment variables.
 */
function getCredentials(source) {
  const { auth } = source;
  if (!auth || !auth.credentials) {
    return null;
  }

  const { emailEnvKey, passwordEnvKey } = auth.credentials;
  const email = process.env[emailEnvKey];
  const password = process.env[passwordEnvKey];

  if (!email || !password) {
    console.warn(`[${source.id}] Missing credentials: ${emailEnvKey}, ${passwordEnvKey}`);
    return null;
  }

  return { email, password };
}

/**
 * Execute scraping steps for a source.
 */
async function executeSteps(page, source, context) {
  const { steps } = source;

  for (const step of steps) {
    console.log(`[${source.id}] Executing step: ${step.action}`);

    try {
      switch (step.action) {
        case 'goto':
          await page.goto(step.url, { waitUntil: 'networkidle', timeout: step.timeout || 30000 });
          break;

        case 'wait':
          await page.waitForSelector(step.selector, { timeout: step.timeout || 10000 });
          break;

        case 'click':
          await page.click(step.selector);
          break;

        case 'type':
          await page.fill(step.selector, step.value);
          break;

        case 'waitForDownload':
          const downloadPath = await waitForDownload(page, context, source.id, step.timeout || 30000);
          if (downloadPath) {
            console.log(`[${source.id}] Downloaded file: ${downloadPath}`);
            return downloadPath;
          }
          break;

        case 'screenshot':
          const screenshotPath = path.join(SCREENSHOTS_DIR, `${source.id}-${Date.now()}.png`);
          await page.screenshot({ path: screenshotPath, fullPage: true });
          console.log(`[${source.id}] Screenshot saved: ${screenshotPath}`);
          break;

        default:
          console.warn(`[${source.id}] Unknown action: ${step.action}`);
      }

      // Wait between steps
      await page.waitForTimeout(1000);
    } catch (error) {
      console.error(`[${source.id}] Step failed (${step.action}):`, error.message);
      throw error;
    }
  }

  return null;
}

/**
 * Perform login.
 */
async function performLogin(page, source, credentials) {
  const { auth } = source;
  if (!auth || auth.type !== 'email_password') {
    return;
  }

  console.log(`[${source.id}] Logging in...`);

  const { selectors } = auth;

  // Fill email
  await page.waitForSelector(selectors.email, { timeout: 10000 });
  await page.fill(selectors.email, credentials.email);
  await page.waitForTimeout(1000);

  // Fill password with retry for dynamic forms
  let passwordFilled = false;
  for (let attempt = 0; attempt < 3 && !passwordFilled; attempt++) {
    try {
      await page.waitForSelector(selectors.password, { timeout: 10000, state: 'attached' });
      await page.waitForTimeout(1000); // Wait for form to stabilize
      await page.fill(selectors.password, credentials.password, { timeout: 5000 });
      passwordFilled = true;
      console.log(`[${source.id}] Password filled successfully`);
    } catch (error) {
      console.log(`[${source.id}] Password fill attempt ${attempt + 1} failed: ${error.message}`);
      if (attempt < 2) {
        await page.waitForTimeout(2000); // Wait before retry
      } else {
        throw error;
      }
    }
  }

  // Submit
  await page.click(selectors.submit);

  // Wait for navigation
  await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 30000 });

  console.log(`[${source.id}] Login successful`);
}

/**
 * Wait for download and return file path.
 */
async function waitForDownload(page, context, sourceId, timeout) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Download timeout'));
    }, timeout);

    page.once('download', async (download) => {
      clearTimeout(timer);
      const fileName = `${sourceId}-${Date.now()}.pdf`;
      const filePath = path.join(DOWNLOADS_DIR, fileName);
      await download.saveAs(filePath);
      resolve(filePath);
    });
  });
}

/**
 * Upload file to Workers API.
 */
async function uploadToWorkers(filePath, source) {
  if (!WORKERS_API_KEY) {
    console.warn(`[${source.id}] WORKERS_API_KEY not set, skipping upload`);
    return;
  }

  const fileBuffer = await fs.readFile(filePath);
  const fileName = path.basename(filePath);

  const formData = new FormData();
  formData.append('file', new Blob([fileBuffer], { type: 'application/pdf' }), fileName);
  formData.append('source', source.id);

  const response = await fetch(`${WORKERS_API_URL}/api/receipts/upload`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${WORKERS_API_KEY}`,
    },
    body: formData,
  });

  if (!response.ok) {
    throw new Error(`Upload failed: ${response.status} ${await response.text()}`);
  }

  const result = await response.json();
  console.log(`[${source.id}] Uploaded to Workers:`, result);
  return result;
}

/**
 * Scrape a single source.
 */
async function scrapeSource(browser, source) {
  console.log(`\n[${source.id}] Starting scrape: ${source.name}`);

  const context = await browser.newContext({
    acceptDownloads: true,
    viewport: { width: 1920, height: 1080 },
  });

  const page = await context.newPage();

  try {
    // Get credentials
    const credentials = getCredentials(source);
    if (!credentials) {
      throw new Error('Missing credentials');
    }

    // Navigate to URL
    await page.goto(source.url, { waitUntil: 'networkidle' });

    // Perform login
    await performLogin(page, source, credentials);

    // Execute scraping steps
    const downloadPath = await executeSteps(page, source, context);

    if (downloadPath) {
      // Upload to Workers
      await uploadToWorkers(downloadPath, source);

      // Clean up
      await fs.unlink(downloadPath);
      console.log(`[${source.id}] Cleaned up download: ${downloadPath}`);
    }

    console.log(`[${source.id}] Scrape completed successfully`);
    return { success: true, source: source.id };
  } catch (error) {
    console.error(`[${source.id}] Scrape failed:`, error.message);

    // Take error screenshot
    try {
      const screenshotPath = path.join(SCREENSHOTS_DIR, `${source.id}-error-${Date.now()}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true });
      console.log(`[${source.id}] Error screenshot: ${screenshotPath}`);
    } catch (screenshotError) {
      console.error(`[${source.id}] Failed to take error screenshot:`, screenshotError.message);
    }

    return { success: false, source: source.id, error: error.message };
  } finally {
    await context.close();
  }
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const args = process.argv.slice(2);
  const sourceArg = args.find((arg) => arg.startsWith('--source='))?.split('=')[1] || 'all';

  console.log('Web Receipt Scraper');
  console.log('===================');
  console.log(`Source: ${sourceArg}`);
  console.log(`Workers API: ${WORKERS_API_URL}`);

  // Ensure directories exist
  await fs.mkdir(SCREENSHOTS_DIR, { recursive: true });
  await fs.mkdir(DOWNLOADS_DIR, { recursive: true });

  // Load configuration
  const config = await loadConfig();
  console.log(`Loaded ${config.sources.length} sources`);

  // Filter sources
  const sources = config.sources.filter((source) => {
    if (!source.enabled) {
      console.log(`[${source.id}] Skipping (disabled)`);
      return false;
    }
    if (sourceArg !== 'all' && source.id !== sourceArg) {
      console.log(`[${source.id}] Skipping (not selected)`);
      return false;
    }
    return true;
  });

  if (sources.length === 0) {
    console.log('No sources to scrape');
    return;
  }

  // Launch browser
  console.log('\nLaunching browser...');
  const browser = await chromium.launch({ headless: true });

  // Scrape sources
  const results = [];
  for (const source of sources) {
    const result = await scrapeSource(browser, source);
    results.push(result);
  }

  // Close browser
  await browser.close();

  // Summary
  console.log('\n===================');
  console.log('Summary:');
  const successful = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;
  console.log(`Successful: ${successful}`);
  console.log(`Failed: ${failed}`);

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
