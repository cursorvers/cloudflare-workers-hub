import { Env } from '../types';
import { handleReceiptUpload } from './receipt-upload';
import { handleReceiptDetail, handleReceiptExport, handleReceiptFileDownload, handleReceiptSearch } from './receipt-search';
import { handleReceiptSourcesAPI } from './receipt-sources-api';
import { handleReceiptList, handleReceiptSummary } from './receipt-status-api';
import { handleDLQAPI } from './dlq-api';
import { resolveTenantContext, type ResolvedTenantContext } from '../utils/tenant-isolation';

type DangerousAction = 'retry' | 'backfill';
const RESERVED_RECEIPT_COLLECTION_PREFIXES = [
  '/api/receipts/sources',
  '/api/receipts/dlq',
];

async function requireAdmin(request: Request, env: Env): Promise<Response | null> {
  const { verifyAPIKey } = await import('../utils/api-auth');
  if (!verifyAPIKey(request, env, 'admin')) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return null;
}

async function requireAdminTenant(
  request: Request,
  env: Env
): Promise<{ response?: Response; tenantContext?: ResolvedTenantContext }> {
  const denied = await requireAdmin(request, env);
  if (denied) return { response: denied };

  const tenantResult = await resolveTenantContext(request, env, 'admin');
  if (!tenantResult.ok || !tenantResult.tenantContext) {
    return {
      response: jsonResponse({ error: tenantResult.error || 'Unauthorized' }, tenantResult.status || 401),
    };
  }

  return { tenantContext: tenantResult.tenantContext };
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function parseDangerousActionControls(request: Request, action: DangerousAction): {
  dryRun: boolean;
  confirmed: boolean;
  confirmToken: string;
} {
  const url = new URL(request.url);
  const dryRun = (url.searchParams.get('dry_run') ?? 'true') !== 'false';
  const confirmToken = `execute-${action}`;
  const confirmed = !dryRun && url.searchParams.get('confirm') === confirmToken;
  return { dryRun, confirmed, confirmToken };
}

function isReservedReceiptCollectionPath(path: string): boolean {
  return RESERVED_RECEIPT_COLLECTION_PREFIXES.some((prefix) =>
    path === prefix || path.startsWith(`${prefix}/`)
  );
}

/**
 * Handle all /api/receipts/* routes.
 * Preserves exact route ordering from original index.ts.
 */
export async function handleReceiptAPI(
  request: Request,
  env: Env,
  path: string,
): Promise<Response> {
  // Manual Gmail polling trigger (admin only)
  if (path === '/api/receipts/poll' && request.method === 'POST') {
    const tenantResult = await requireAdminTenant(request, env);
    if (tenantResult.response) return tenantResult.response;
    const { handleGmailReceiptPolling } = await import('./receipt-gmail-poller');
    try {
      await handleGmailReceiptPolling(env, (tenantResult.tenantContext as ResolvedTenantContext).tenantId);
      return new Response(JSON.stringify({ success: true, message: 'Gmail polling completed' }), { headers: { 'Content-Type': 'application/json' } });
    } catch (error) {
      return new Response(JSON.stringify({ error: String(error) }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
  }

  // Retry failed receipts - fetch from R2 and upload to freee (admin only)
  if (path === '/api/receipts/retry' && request.method === 'POST') {
    const tenantResult = await requireAdminTenant(request, env);
    if (tenantResult.response) return tenantResult.response;
    const tenantContext = tenantResult.tenantContext as ResolvedTenantContext;
    const { dryRun, confirmed, confirmToken } = parseDangerousActionControls(request, 'retry');
    if (!dryRun && !confirmed) {
      return jsonResponse({
        error: 'Confirmation required',
        applied: false,
        dry_run: dryRun,
        required_confirm: confirmToken,
      }, 400);
    }
    const bucket = env.RECEIPTS || env.R2;
    if (!bucket) {
      return jsonResponse({ error: 'R2 bucket not configured' }, 500);
    }
    const { createFreeeClient } = await import('../services/freee-client');
    const freeeClient = dryRun ? null : createFreeeClient(env, { tenantId: tenantContext.tenantId });
    const failed = await env.DB!.prepare(
      `SELECT id, r2_object_key, file_hash FROM receipts WHERE tenant_id = ? AND status = 'failed' ORDER BY created_at DESC LIMIT 50`
    ).bind(tenantContext.tenantId).all();
    const results: Array<{id: string, status: string, freeeId?: string, error?: string}> = [];
    let wouldRetry = 0;
    let retried = 0;
    for (const row of failed.results) {
      try {
        const obj = await bucket.get(row.r2_object_key as string);
        if (!obj) { results.push({ id: row.id as string, status: 'skipped', error: 'R2 object not found' }); continue; }
        if (dryRun) {
          wouldRetry += 1;
          results.push({ id: row.id as string, status: 'would_retry' });
          continue;
        }
        const blob = await obj.blob();
        const fileName = (row.r2_object_key as string).split('/').pop() || 'receipt.pdf';
        const freeeResult = await freeeClient!.uploadReceipt(blob, fileName, `retry:${row.file_hash}`);
        await env.DB!.prepare(
          `UPDATE receipts SET status = 'completed', freee_receipt_id = ?, completed_at = datetime('now'), updated_at = datetime('now') WHERE tenant_id = ? AND id = ?`
        ).bind(String(freeeResult.receipt?.id || ''), tenantContext.tenantId, row.id).run();
        retried += 1;
        results.push({ id: row.id as string, status: 'completed', freeeId: String(freeeResult.receipt?.id || '') });
      } catch (error) {
        results.push({ id: row.id as string, status: 'failed', error: String(error) });
      }
    }
    return jsonResponse({
      success: true,
      applied: !dryRun,
      dry_run: dryRun,
      confirmed,
      would_retry: wouldRetry,
      retried,
      results,
    });
  }

  // Repair freee receipt→deal links (admin only)
  if (path === '/api/receipts/repair-freee-links' && request.method === 'POST') {
    const tenantResult = await requireAdminTenant(request, env);
    if (tenantResult.response) return tenantResult.response;
    const { handleRepairFreeeLinks } = await import('./receipt-freee-repair');
    return handleRepairFreeeLinks(
      request,
      env,
      (tenantResult.tenantContext as ResolvedTenantContext).tenantId
    );
  }

  // Backfill receipts - re-classify and create deals (admin only)
  if (path === '/api/receipts/backfill' && request.method === 'POST') {
    const tenantResult = await requireAdminTenant(request, env);
    if (tenantResult.response) return tenantResult.response;
    const { handleReceiptBackfill } = await import('./receipt-backfill');
    return handleReceiptBackfill(request, env);
  }

  // Repair HTML receipt text evidence + optionally re-classify (admin only)
  if (path === '/api/receipts/repair-html-text' && request.method === 'POST') {
    const tenantResult = await requireAdminTenant(request, env);
    if (tenantResult.response) return tenantResult.response;
    const { handleRepairHtmlReceiptText } = await import('./receipt-html-text-repair');
    return handleRepairHtmlReceiptText(request, env);
  }

  // Receipt Upload API endpoint (freee integration) — NOT admin-only
  if (path === '/api/receipts/upload' && request.method === 'POST') {
    return handleReceiptUpload(request, env);
  }

  // Receipt Status API: summary (admin only)
  if (path === '/api/receipts/summary' && request.method === 'GET') {
    const tenantResult = await requireAdminTenant(request, env);
    if (tenantResult.response) return tenantResult.response;
    return handleReceiptSummary(request, env, tenantResult.tenantContext as ResolvedTenantContext);
  }

  // Receipt Status API: filtered list (admin only)
  if (path === '/api/receipts' && request.method === 'GET') {
    const tenantResult = await requireAdminTenant(request, env);
    if (tenantResult.response) return tenantResult.response;
    return handleReceiptList(request, env, tenantResult.tenantContext as ResolvedTenantContext);
  }

  // Receipt Search API endpoint (Electronic Bookkeeping Law compliant) — NOT admin-only
  if (path === '/api/receipts/search' && request.method === 'GET') {
    return handleReceiptSearch(request, env);
  }

  // Receipt Export API endpoint (admin only)
  if (path === '/api/receipts/export' && request.method === 'GET') {
    const tenantResult = await requireAdminTenant(request, env);
    if (tenantResult.response) return tenantResult.response;
    return handleReceiptExport(request, env, tenantResult.tenantContext as ResolvedTenantContext);
  }

  // Receipt Sources API (web receipt scraper orchestration) — admin only
  if (path.startsWith('/api/receipts/sources')) {
    const denied = await requireAdmin(request, env);
    if (denied) return denied;
    return handleReceiptSourcesAPI(request, env, path);
  }

  // Dead Letter Queue API (Failed receipt processing management)
  if (path.startsWith('/api/receipts/dlq')) {
    return handleDLQAPI(request, env, path);
  }

  // Receipt Detail + File Download (admin only)
  if (
    (request.method === 'GET' || request.method === 'HEAD') &&
    path.startsWith('/api/receipts/') &&
    !isReservedReceiptCollectionPath(path)
  ) {
    const mFile = path.match(/^\/api\/receipts\/([A-Za-z0-9_-]+)\/file$/);
    if (mFile) {
      const denied = await requireAdmin(request, env);
      if (denied) return denied;
      const tenantResult = await resolveTenantContext(request, env, 'admin');
      if (!tenantResult.ok || !tenantResult.tenantContext) {
        return jsonResponse({ error: tenantResult.error || 'Unauthorized' }, tenantResult.status || 401);
      }
      return handleReceiptFileDownload(request, env, mFile[1], tenantResult.tenantContext);
    }

    const mDetail = path.match(/^\/api\/receipts\/([A-Za-z0-9_-]+)$/);
    if (mDetail) {
      const denied = await requireAdmin(request, env);
      if (denied) return denied;
      const tenantResult = await resolveTenantContext(request, env, 'admin');
      if (!tenantResult.ok || !tenantResult.tenantContext) {
        return jsonResponse({ error: tenantResult.error || 'Unauthorized' }, tenantResult.status || 401);
      }
      return handleReceiptDetail(request, env, mDetail[1], tenantResult.tenantContext);
    }
  }

  return new Response('Not found', { status: 404 });
}
