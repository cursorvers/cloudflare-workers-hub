import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@sentry/cloudflare', () => ({
  withSentry: (_config: unknown, worker: unknown) => worker,
  instrumentDurableObjectWithSentry: (_config: unknown, klass: unknown) => klass,
}));

vi.mock('./adapters/commhub', () => ({
  CommHubAdapter: class {
    setKV() {}
    setDB() {}
  },
}));

vi.mock('./utils/secrets-validator', () => ({
  performStartupCheck: vi.fn(),
}));

vi.mock('./utils/log-sanitizer', () => ({
  safeLog: {
    error: vi.fn(),
    warn: vi.fn(),
    log: vi.fn(),
  },
}));

vi.mock('./utils/canary-write-gate', () => ({
  getDeployTarget: vi.fn(() => 'production'),
  isCanaryWriteEnabled: vi.fn(() => true),
  maybeBlockCanaryWrite: vi.fn(() => null),
}));

vi.mock('./utils/sentry', () => ({
  createSentryConfig: vi.fn(() => ({})),
}));

vi.mock('./durable-objects/task-coordinator', () => ({ TaskCoordinator: class {} }));
vi.mock('./durable-objects/cockpit-websocket', () => ({ CockpitWebSocket: class {} }));
vi.mock('./durable-objects/system-events', () => ({ SystemEvents: class {} }));
vi.mock('./durable-objects/rate-limiter', () => ({ RateLimiter: class {} }));
vi.mock('./durable-objects/run-coordinator', () => ({ RunCoordinator: class {} }));
vi.mock('./fugue/autopilot/durable-objects/autopilot-coordinator', () => ({ AutopilotCoordinator: class {} }));
vi.mock('./fugue/autopilot/durable-objects/safety-sentinel', () => ({ SafetySentinel: class {} }));

vi.mock('./handlers/initialization', () => ({
  ensureServiceRoleMappings: vi.fn(async () => undefined),
}));
vi.mock('./handlers/generic-webhook', () => ({
  initGenericWebhook: vi.fn(),
}));
vi.mock('./handlers/webhook-router', () => ({
  handleWebhook: vi.fn(async () => new Response('ok')),
}));
vi.mock('./handlers/channels/whatsapp', () => ({
  handleWhatsAppWebhook: vi.fn(async () => new Response('ok')),
}));
vi.mock('./handlers/queue', () => ({
  handleQueueAPI: vi.fn(async () => new Response('queue')),
}));
vi.mock('./handlers/health', () => ({
  handleHealthCheck: vi.fn(async () => new Response('healthy')),
  handleMetrics: vi.fn(async () => new Response('metrics')),
}));
vi.mock('./handlers/memory-api', () => ({
  handleMemoryAPI: vi.fn(async () => new Response('memory')),
}));
vi.mock('./handlers/cron-api', () => ({
  handleCronAPI: vi.fn(async () => new Response('cron')),
}));
vi.mock('./handlers/admin-api', () => ({
  handleAdminAPI: vi.fn(async () => new Response('admin')),
}));
vi.mock('./handlers/daemon-api', () => ({
  handleDaemonAPI: vi.fn(async () => new Response('daemon')),
}));
vi.mock('./handlers/limitless-api', () => ({
  handleLimitlessAPI: vi.fn(async () => new Response('limitless')),
}));
vi.mock('./handlers/limitless-webhook', () => ({
  handleLimitlessWebhook: vi.fn(async () => new Response('limitless-webhook')),
}));
vi.mock('./handlers/scheduled', () => ({
  handleScheduled: vi.fn(async () => undefined),
}));
vi.mock('./handlers/cockpit-api', () => ({
  handleCockpitAPI: vi.fn(async () => new Response('cockpit')),
}));
vi.mock('./handlers/orchestrate-api', () => ({
  handleOrchestrateAPI: vi.fn(async () => new Response('orchestrate')),
}));
vi.mock('./handlers/strategic-advisor-api', () => ({
  handleAdvisorAPI: vi.fn(async () => new Response('advisor')),
}));
vi.mock('./handlers/usage-api', () => ({
  handleUsageAPI: vi.fn(async () => new Response('usage')),
}));
vi.mock('./handlers/goal-planner', () => ({
  handleGoalPlannerAPI: vi.fn(async () => new Response('goals')),
}));
vi.mock('./handlers/push-queue-consumer', () => ({
  handlePushQueueBatch: vi.fn(async () => undefined),
}));
vi.mock('./fugue/autopilot/handlers/autopilot-api', () => ({
  handleAutopilotAPI: vi.fn(async () => new Response('autopilot')),
}));
vi.mock('./handlers/finance-automation-api', () => ({
  handleFinanceAutomationAPI: vi.fn(async () => new Response(JSON.stringify({ error: 'Unauthorized' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  })),
}));
vi.mock('./static/cockpit-html', () => ({
  COCKPIT_HTML: '<html></html>',
}));
vi.mock('./static/service-worker', () => ({
  handleServiceWorker: vi.fn(() => new Response('// sw')),
}));

import { handleFinanceAutomationAPI } from './handlers/finance-automation-api';
import { handleOrchestrateAPI } from './handlers/orchestrate-api';

function createEnv(overrides?: Record<string, unknown>) {
  return {
    ENVIRONMENT: 'production',
    DEPLOY_TARGET: 'production',
    CACHE: undefined,
    DB: undefined,
    ...overrides,
  } as any;
}

async function loadWorker() {
  vi.resetModules();
  const mod = await import('./index');
  return mod.default as { fetch: (request: Request, env: any, ctx: ExecutionContext) => Promise<Response> };
}

function createExecutionContext(): ExecutionContext {
  return {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
  } as unknown as ExecutionContext;
}

describe('production route simulation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('exposes /api/finance/status in production instead of falling through to 404', async () => {
    const worker = await loadWorker();

    const response = await worker.fetch(
      new Request('https://example.com/api/finance/status'),
      createEnv(),
      createExecutionContext(),
    );

    expect(response.status).toBe(401);
    expect(handleFinanceAutomationAPI).toHaveBeenCalledWith(
      expect.any(Request),
      expect.anything(),
      '/api/finance/status',
    );
  });

  it('exposes /api/fugue/finance/run in production instead of falling through to 404', async () => {
    const worker = await loadWorker();

    const response = await worker.fetch(
      new Request('https://example.com/api/fugue/finance/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dry_run: true }),
      }),
      createEnv(),
      createExecutionContext(),
    );

    expect(response.status).toBe(401);
    expect(handleFinanceAutomationAPI).toHaveBeenCalledWith(
      expect.any(Request),
      expect.anything(),
      '/api/fugue/finance/run',
    );
  });

  it('exposes /api/orchestrate in production instead of falling through to 404', async () => {
    const worker = await loadWorker();

    const response = await worker.fetch(
      new Request('https://example.com/api/orchestrate'),
      createEnv(),
      createExecutionContext(),
    );

    expect(response.status).toBe(200);
    expect(handleOrchestrateAPI).toHaveBeenCalledWith(
      expect.any(Request),
      expect.anything(),
      '/api/orchestrate',
      expect.anything(),
    );
  });

  it('does not regress /api/freee/auth route availability under production config', async () => {
    vi.doMock('./handlers/freee-oauth', () => ({
      handleFreeeOAuth: vi.fn(async () => new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })),
    }));
    const worker = await loadWorker();

    const response = await worker.fetch(
      new Request('https://example.com/api/freee/auth'),
      createEnv({ FREEE_INTEGRATION_ENABLED: 'true' }),
      createExecutionContext(),
    );

    expect(response.status).toBe(401);
  });

  it('does not regress /api/receipts/retry route availability under production config', async () => {
    vi.doMock('./handlers/receipt-admin-api', () => ({
      handleReceiptAPI: vi.fn(async () => new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })),
    }));
    const worker = await loadWorker();

    const response = await worker.fetch(
      new Request('https://example.com/api/receipts/retry', { method: 'POST' }),
      createEnv(),
      createExecutionContext(),
    );

    expect(response.status).toBe(401);
  });
});
