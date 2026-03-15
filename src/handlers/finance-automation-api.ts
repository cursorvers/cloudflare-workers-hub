import type { Env } from '../types';
import { verifyAPIKey } from '../utils/api-auth';
import { authenticateBearer } from '../fugue/autopilot/auth';
import {
  FINANCE_AUTOMATION_CONFIRM_TOKEN,
  FINANCE_OPERATION_IDS,
  type FinanceAutomationRequest,
  type FinanceOperationId,
  collectFinanceAutomationSnapshot,
  runFinanceAutomation,
} from '../services/finance-automation';
import { resolveTenantContext } from '../utils/tenant-isolation';

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const STATUS_PATHS = new Set(['/api/finance/status', '/api/fugue/finance/status']);
const RUN_PATHS = new Set(['/api/finance/run', '/api/fugue/finance/run']);

interface FinanceAuthResult {
  readonly authorized: boolean;
  readonly mode: 'admin' | 'autopilot' | 'none';
}

interface PrivilegedRequestResult {
  readonly ok: boolean;
  readonly request?: Request;
  readonly response?: Response;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: JSON_HEADERS,
  });
}

function unauthorizedResponse(): Response {
  return jsonResponse({ error: 'Unauthorized' }, 401);
}

function parseBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value === 'true') return true;
    if (value === 'false') return false;
  }
  return fallback;
}

function parseOperations(value: unknown): FinanceOperationId[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const allowed = new Set<string>(FINANCE_OPERATION_IDS);
  const operations = value.filter((entry): entry is FinanceOperationId =>
    typeof entry === 'string' && allowed.has(entry)
  );
  return operations.length > 0 ? operations : undefined;
}

function authorizeFinanceRequest(request: Request, env: Env): FinanceAuthResult {
  if (verifyAPIKey(request, env, 'admin')) {
    return { authorized: true, mode: 'admin' };
  }

  const autopilotToken = env.AUTOPILOT_API_KEY?.trim();
  if (!autopilotToken) {
    return { authorized: false, mode: 'none' };
  }

  const authResult = authenticateBearer(request.headers.get('Authorization'), [autopilotToken]);
  if (!authResult.authenticated) {
    return { authorized: false, mode: 'none' };
  }

  return { authorized: true, mode: 'autopilot' };
}

function buildPrivilegedRequest(
  request: Request,
  env: Env,
  mode: FinanceAuthResult['mode'],
): PrivilegedRequestResult {
  if (mode !== 'autopilot') {
    return { ok: true, request };
  }

  const adminToken = env.ADMIN_API_KEY?.trim() || env.WORKERS_API_KEY?.trim() || '';
  if (!adminToken) {
    return {
      ok: false,
      response: jsonResponse({
        error: 'Autopilot mode requires ADMIN_API_KEY or WORKERS_API_KEY',
      }, 500),
    };
  }

  const headers = new Headers(request.headers);
  headers.set('Authorization', `Bearer ${adminToken}`);
  headers.delete('X-API-Key');

  return {
    ok: true,
    request: new Request(request.url, {
      method: request.method,
      headers,
    }),
  };
}

export async function handleFinanceAutomationAPI(
  request: Request,
  env: Env,
  path: string,
): Promise<Response> {
  const isStatusRoute = STATUS_PATHS.has(path);
  const isRunRoute = RUN_PATHS.has(path);
  if (!isStatusRoute && !isRunRoute) {
    return jsonResponse({ error: 'Not found' }, 404);
  }

  const auth = authorizeFinanceRequest(request, env);
  if (!auth.authorized) {
    return unauthorizedResponse();
  }

  const privilegedRequestResult = buildPrivilegedRequest(request, env, auth.mode);
  if (!privilegedRequestResult.ok) {
    return privilegedRequestResult.response as Response;
  }

  const tenantResult = await resolveTenantContext(
    privilegedRequestResult.request as Request,
    env,
    'admin'
  );
  if (!tenantResult.ok || !tenantResult.tenantContext) {
    return jsonResponse({ error: tenantResult.error || 'Unauthorized' }, tenantResult.status || 401);
  }
  const tenantId = tenantResult.tenantContext.tenantId;

  if (isStatusRoute) {
    if (request.method !== 'GET') {
      return jsonResponse({ error: 'Method not allowed' }, 405);
    }

    const url = new URL(request.url);
    const sampleLimit = Number.parseInt(url.searchParams.get('sample_limit') ?? '5', 10);
    const snapshot = await collectFinanceAutomationSnapshot(env, tenantId, sampleLimit);
    return jsonResponse({
      success: true,
      controlPlane: 'finance-backend',
      compatibleWith: ['fugue', 'freee-mcp'],
      authMode: auth.mode,
      tenantId,
      snapshot,
    });
  }

  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  let body: Record<string, unknown> = {};
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    body = {};
  }

  const dryRun = parseBoolean(body.dry_run, true);
  const confirm = typeof body.confirm === 'string' ? body.confirm : '';
  if (!dryRun && confirm !== FINANCE_AUTOMATION_CONFIRM_TOKEN) {
    return jsonResponse({
      error: 'Confirmation required',
      applied: false,
      dry_run: false,
      required_confirm: FINANCE_AUTOMATION_CONFIRM_TOKEN,
    }, 400);
  }

  const options: Partial<FinanceAutomationRequest> = {
    dryRun,
    limit: typeof body.limit === 'number' ? body.limit : Number.parseInt(String(body.limit ?? 20), 10),
    sampleLimit: typeof body.sample_limit === 'number' ? body.sample_limit : Number.parseInt(String(body.sample_limit ?? 5), 10),
    reclassify: parseBoolean(body.reclassify, true),
    onlyMissingText: parseBoolean(body.only_missing_text, true),
    operations: parseOperations(body.operations),
  };

  const snapshot = await collectFinanceAutomationSnapshot(env, tenantId, options.sampleLimit);
  const run = await runFinanceAutomation(privilegedRequestResult.request as Request, env, tenantId, options);

  return jsonResponse({
    success: true,
    controlPlane: 'finance-backend',
    compatibleWith: ['fugue', 'freee-mcp'],
    authMode: auth.mode,
    tenantId,
    snapshot,
    run,
  });
}
