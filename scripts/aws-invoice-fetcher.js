#!/usr/bin/env node
/**
 * AWS Invoice Fetcher
 *
 * Fetches invoices from AWS Cost Explorer API and uploads to Workers API.
 * Uses AWS SDK v3 with IAM credentials (no browser automation).
 *
 * Required env vars:
 *   AWS_ACCESS_KEY_ID       - IAM user access key
 *   AWS_SECRET_ACCESS_KEY   - IAM user secret key
 *   AWS_REGION              - Region (default: us-east-1)
 *   WORKERS_API_URL         - Workers API endpoint
 *   WORKERS_API_KEY         - Workers API key
 *
 * IAM Policy required:
 *   - cur:DescribeReportDefinitions
 *   - ce:GetCostAndUsage
 *   - organizations:ListAccounts (optional, for multi-account)
 *   - aws-portal:ViewBilling (for invoice PDF access)
 */

const WORKERS_API_URL = process.env.WORKERS_API_URL || 'https://orchestrator-hub.masa-stage1.workers.dev';
const WORKERS_API_KEY = process.env.WORKERS_API_KEY;
const AWS_REGION = process.env.AWS_REGION || 'us-east-1';

/**
 * Sign AWS API request using Signature V4 (simplified).
 * For production, use @aws-sdk/client-cost-explorer.
 */
async function awsRequest(service, endpoint, method = 'POST', body = null, headers = {}) {
  // This is a placeholder for AWS SDK integration.
  // In production, use:
  //   import { CostExplorerClient, GetCostAndUsageCommand } from '@aws-sdk/client-cost-explorer';
  throw new Error(
    'AWS SDK not yet integrated. Install @aws-sdk/client-cost-explorer and configure IAM credentials. ' +
    'See: https://docs.aws.amazon.com/cost-management/latest/userguide/ce-api.html'
  );
}

/**
 * Get cost summary for the specified period.
 */
async function getCostSummary(startDate, endDate) {
  // Placeholder: Will use CostExplorerClient.send(new GetCostAndUsageCommand({...}))
  console.log(`[aws] Fetching costs for ${startDate} to ${endDate}`);
  return awsRequest('ce', '/GetCostAndUsage', 'POST', {
    TimePeriod: { Start: startDate, End: endDate },
    Granularity: 'MONTHLY',
    Metrics: ['UnblendedCost'],
    GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }],
  });
}

/**
 * Upload invoice data to Workers API.
 */
async function uploadToWorkers(data, metadata = {}) {
  if (!WORKERS_API_KEY) {
    console.warn('[aws] WORKERS_API_KEY not set, skipping upload');
    return null;
  }

  const jsonBlob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const fileName = `aws-cost-report-${metadata.period || 'unknown'}.json`;

  const formData = new FormData();
  formData.append('file', jsonBlob, fileName);
  formData.append('source', 'aws');
  formData.append('vendor_name', 'Amazon Web Services');
  formData.append('transaction_date', metadata.endDate || new Date().toISOString().slice(0, 10));
  formData.append('amount', String(Math.round((metadata.totalCost || 0) * 100)));
  formData.append('currency', 'USD');
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

/**
 * Get date range for the previous month.
 */
function getLastMonthRange() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const end = new Date(now.getFullYear(), now.getMonth(), 1);
  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
  };
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');

  console.log('AWS Invoice Fetcher');
  console.log('===================');
  console.log(`Region: ${AWS_REGION}`);
  console.log(`Workers API: ${WORKERS_API_URL}`);
  console.log(`Dry run: ${dryRun}`);

  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
    console.error('Error: AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are required');
    console.error('');
    console.error('Setup steps:');
    console.error('  1. Create IAM user with CostExplorer read access');
    console.error('  2. npm install @aws-sdk/client-cost-explorer');
    console.error('  3. Set env vars and re-run');
    process.exit(1);
  }

  const { startDate, endDate } = getLastMonthRange();
  console.log(`\nPeriod: ${startDate} to ${endDate}`);

  if (dryRun) {
    console.log('[DRY RUN] Would fetch and upload AWS cost data');
    return;
  }

  try {
    const costData = await getCostSummary(startDate, endDate);
    console.log('[aws] Cost data retrieved:', JSON.stringify(costData, null, 2));

    await uploadToWorkers(costData, {
      period: `${startDate}_${endDate}`,
      startDate,
      endDate,
    });

    console.log('[aws] Upload complete');
  } catch (error) {
    console.error('[aws] Error:', error.message);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
