import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/api-auth', () => ({
  verifyAPIKey: vi.fn(),
}));

vi.mock('../utils/jwt-auth', () => ({
  authenticateRequest: vi.fn(),
}));

vi.mock('../utils/cloudflare-access', () => ({
  authenticateWithAccess: vi.fn(),
  mapAccessUserToInternal: vi.fn(),
}));

vi.mock('../fugue/autopilot/auth', () => ({
  authenticateBearer: vi.fn(),
}));

vi.mock('../utils/rate-limiter', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
  createRateLimitErrorResponse: vi.fn(() => new Response('rate limited', { status: 429 })),
}));

vi.mock('../utils/do-fetch', () => ({
  doFetch: vi.fn(),
}));

import { verifyAPIKey } from '../utils/api-auth';
import { authenticateRequest } from '../utils/jwt-auth';
import { authenticateWithAccess, mapAccessUserToInternal } from '../utils/cloudflare-access';
import { authenticateBearer } from '../fugue/autopilot/auth';
import { doFetch } from '../utils/do-fetch';
import { handleOrchestrateAPI } from './orchestrate-api';

class FakeStatement {
  private args: unknown[] = [];

  constructor(
    private readonly db: { runs: Array<Record<string, unknown>>; costEvents: unknown[] },
    private readonly sql: string,
  ) {}

  bind(...args: unknown[]) {
    this.args = args;
    return this;
  }

  async run() {
    if (this.sql.includes('INSERT INTO runs')) {
      const [runId, ownerId, instruction, budgetUsd, maxSteps, createdAt, updatedAt] = this.args;
      this.db.runs.push({
        run_id: runId,
        owner_id: ownerId,
        instruction,
        status: 'pending',
        budget_usd: budgetUsd,
        cost_usd: 0,
        memory_json: '{}',
        step_count: 0,
        max_steps: maxSteps,
        created_at: createdAt,
        updated_at: updatedAt,
      });
      return { meta: { changes: 1 } };
    }

    if (this.sql.includes('INSERT INTO cost_events')) {
      this.db.costEvents.push({ args: this.args });
      return { meta: { changes: 1 } };
    }

    if (this.sql.includes('UPDATE runs SET step_count = ?, updated_at = ? WHERE run_id = ?')) {
      const [stepCount, updatedAt, runId] = this.args;
      const run = this.db.runs.find((candidate) => candidate.run_id === runId);
      if (!run) return { meta: { changes: 0 } };
      run.step_count = stepCount;
      run.updated_at = updatedAt;
      return { meta: { changes: 1 } };
    }

    if (this.sql.includes("UPDATE runs SET status = 'running', updated_at = ? WHERE run_id = ?")) {
      const [updatedAt, runId] = this.args;
      const run = this.db.runs.find((candidate) => candidate.run_id === runId);
      if (!run) return { meta: { changes: 0 } };
      run.status = 'running';
      run.updated_at = updatedAt;
      return { meta: { changes: 1 } };
    }

    if (this.sql.includes('UPDATE runs SET status = ?, cost_usd = ?, step_count = ?, updated_at = ? WHERE run_id = ?')) {
      const [status, costUsd, stepCount, updatedAt, runId] = this.args;
      const run = this.db.runs.find((candidate) => candidate.run_id === runId);
      if (!run) return { meta: { changes: 0 } };
      run.status = status;
      run.cost_usd = costUsd;
      run.step_count = stepCount;
      run.updated_at = updatedAt;
      return { meta: { changes: 1 } };
    }

    throw new Error(`Unsupported SQL: ${this.sql}`);
  }
}

class FakeDB {
  readonly runs: Array<Record<string, unknown>> = [];
  readonly costEvents: unknown[] = [];

  prepare(sql: string) {
    return new FakeStatement(this, sql);
  }
}

function createEnv(overrides?: Record<string, unknown>) {
  return {
    DB: new FakeDB(),
    ADMIN_API_KEY: 'admin-key',
    WORKERS_API_KEY: 'workers-key',
    RUN_COORDINATOR: {
      idFromName: vi.fn((value: string) => value),
      get: vi.fn(() => ({ fetch: vi.fn() })),
    },
    AI: {
      run: vi.fn().mockResolvedValue({
        response: JSON.stringify({
          steps: [
            { seq: 1, capability: 'code', description: 'first', input: { task: 'first' }, risk: 'low', max_attempts: 1 },
            { seq: 2, capability: 'code', description: 'second', input: { task: 'second' }, risk: 'low', max_attempts: 1 },
          ],
        }),
      }),
    },
    ...overrides,
  } as any;
}

describe('handleOrchestrateAPI max_steps propagation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(verifyAPIKey).mockReturnValue(true);
    vi.mocked(authenticateRequest).mockResolvedValue({ authenticated: false } as any);
    vi.mocked(authenticateWithAccess).mockResolvedValue({ verified: false } as any);
    vi.mocked(mapAccessUserToInternal).mockResolvedValue(null);
    vi.mocked(authenticateBearer).mockReturnValue({ authenticated: false } as any);
    vi.mocked(doFetch).mockImplementation(async (_stub, url, init) => {
      if (url === 'https://do/start') {
        const body = JSON.parse(String(init?.body)) as { steps: unknown[] };
        expect(body.steps).toHaveLength(1);
        return new Response(JSON.stringify({ success: true, data: { run: {}, action: { action: 'execute_step' } } }));
      }
      if (url === 'https://do/state') {
        return new Response(JSON.stringify({
          data: {
            run: {
              run_id: 'run-1',
              status: 'running',
              budget_usd: 1,
              cost_usd: 0,
              step_count: 1,
              created_at: '2026-03-09T00:00:00.000Z',
              updated_at: '2026-03-09T00:00:01.000Z',
            },
            steps: [],
          },
        }));
      }
      return new Response('not found', { status: 404 });
    });
  });

  it('passes max_steps to task decomposition and DO start', async () => {
    const env = createEnv();
    const backgroundTasks: Promise<unknown>[] = [];
    const ctx = { waitUntil(promise: Promise<unknown>) { backgroundTasks.push(promise); } };

    const response = await handleOrchestrateAPI(
      new Request('https://example.com/api/orchestrate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': 'admin-key',
        },
        body: JSON.stringify({ instruction: 'trim to one step', max_steps: 1 }),
      }),
      env,
      '/api/orchestrate',
      ctx as any,
    );

    expect(response.status).toBe(202);
    await Promise.all(backgroundTasks);
    expect(env.DB.runs[0]?.step_count).toBe(1);
    expect(env.DB.costEvents).toHaveLength(1);
  });
});
