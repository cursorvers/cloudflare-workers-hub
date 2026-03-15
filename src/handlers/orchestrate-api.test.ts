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

interface RunRecord {
  run_id: string;
  owner_id: string;
  instruction: string;
  status: string;
  budget_usd: number;
  cost_usd: number;
  memory_json: string;
  step_count: number;
  max_steps: number;
  created_at: string;
  updated_at: string;
}

class FakeStatement {
  private args: unknown[] = [];

  constructor(
    private readonly db: FakeDB,
    private readonly sql: string,
  ) {}

  bind(...args: unknown[]) {
    this.args = args;
    return this;
  }

  async run() {
    if (this.sql.includes('INSERT INTO runs')) {
      const [runId, ownerId, instruction, budgetUsd, maxSteps, createdAt, updatedAt] = this.args as [
        string,
        string,
        string,
        number,
        number,
        string,
        string,
      ];
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

    if (this.sql.includes('UPDATE runs SET status = ?, cost_usd = ?, step_count = ?, updated_at = ? WHERE run_id = ?')) {
      const [status, costUsd, stepCount, updatedAt, runId] = this.args as [string, number, number, string, string];
      const run = this.db.runs.find((candidate) => candidate.run_id === runId);
      if (!run) return { meta: { changes: 0 } };
      run.status = status;
      run.cost_usd = costUsd;
      run.step_count = stepCount;
      run.updated_at = updatedAt;
      return { meta: { changes: 1 } };
    }

    if (this.sql.includes('INSERT INTO cost_events')) {
      const [runId, provider, model, tokensIn, tokensOut, usd, createdAt] = this.args as [
        string,
        string,
        string,
        number,
        number,
        number,
        string,
      ];
      this.db.costEvents.push({ runId, provider, model, tokensIn, tokensOut, usd, createdAt });
      return { meta: { changes: 1 } };
    }

    if (this.sql.includes('UPDATE runs SET step_count = ?, updated_at = ? WHERE run_id = ?')) {
      const [stepCount, updatedAt, runId] = this.args as [number, string, string];
      const run = this.db.runs.find((candidate) => candidate.run_id === runId);
      if (!run) return { meta: { changes: 0 } };
      run.step_count = stepCount;
      run.updated_at = updatedAt;
      return { meta: { changes: 1 } };
    }

    if (this.sql.includes("UPDATE runs SET status = 'running', updated_at = ? WHERE run_id = ?")) {
      const [updatedAt, runId] = this.args as [string, string];
      const run = this.db.runs.find((candidate) => candidate.run_id === runId);
      if (!run) return { meta: { changes: 0 } };
      run.status = 'running';
      run.updated_at = updatedAt;
      return { meta: { changes: 1 } };
    }

    if (this.sql.includes("UPDATE runs SET status = 'blocked_error', memory_json = ?, updated_at = ? WHERE run_id = ?")) {
      const [memoryJson, updatedAt, runId] = this.args as [string, string, string];
      const run = this.db.runs.find((candidate) => candidate.run_id === runId);
      if (!run) return { meta: { changes: 0 } };
      run.status = 'blocked_error';
      run.memory_json = memoryJson;
      run.updated_at = updatedAt;
      return { meta: { changes: 1 } };
    }

    throw new Error(`Unsupported run SQL: ${this.sql}`);
  }

  async first<T>() {
    if (this.sql.includes('SELECT * FROM runs WHERE run_id = ? AND owner_id = ?')) {
      const [runId, ownerId] = this.args as [string, string];
      return (this.db.runs.find((run) => run.run_id === runId && run.owner_id === ownerId) ?? null) as T | null;
    }

    if (this.sql.includes('SELECT run_id FROM runs WHERE run_id = ? AND owner_id = ?')) {
      const [runId, ownerId] = this.args as [string, string];
      const run = this.db.runs.find((candidate) => candidate.run_id === runId && candidate.owner_id === ownerId);
      return (run ? ({ run_id: run.run_id } as T) : null);
    }

    throw new Error(`Unsupported first SQL: ${this.sql}`);
  }

  async all<T>() {
    if (this.sql.includes('SELECT * FROM steps WHERE run_id = ? ORDER BY seq ASC')) {
      return { results: [] as T[] };
    }

    throw new Error(`Unsupported all SQL: ${this.sql}`);
  }
}

class FakeDB {
  readonly runs: RunRecord[] = [];
  readonly costEvents: Array<Record<string, unknown>> = [];

  prepare(sql: string) {
    return new FakeStatement(this, sql);
  }
}

function createEnv(overrides?: Record<string, unknown>) {
  return {
    DB: new FakeDB(),
    AUTOPILOT_API_KEY: 'autopilot-key',
    ADMIN_API_KEY: 'admin-key',
    ...overrides,
  } as any;
}

describe('handleOrchestrateAPI auth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(verifyAPIKey).mockReturnValue(false);
    vi.mocked(authenticateRequest).mockResolvedValue({ authenticated: false, error: 'missing' } as any);
    vi.mocked(authenticateWithAccess).mockResolvedValue({ verified: false, error: 'missing' } as any);
    vi.mocked(mapAccessUserToInternal).mockResolvedValue(null);
    vi.mocked(authenticateBearer).mockReturnValue({ authenticated: false, reason: 'missing' } as any);
    vi.mocked(doFetch).mockRejectedValue(new Error('no-do-state'));
  });

  it('rejects unauthenticated orchestration requests', async () => {
    const response = await handleOrchestrateAPI(
      new Request('https://example.com/api/orchestrate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instruction: 'test run' }),
      }),
      createEnv(),
      '/api/orchestrate',
    );

    expect(response.status).toBe(401);
  });

  it('accepts admin api key auth and scopes runs to the orchestration system owner', async () => {
    vi.mocked(verifyAPIKey).mockReturnValue(true);
    const env = createEnv({
      RUN_COORDINATOR: {
        idFromName: vi.fn((value: string) => value),
        get: vi.fn(() => ({ fetch: vi.fn() })),
      },
    });

    const response = await handleOrchestrateAPI(
      new Request('https://example.com/api/orchestrate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': 'admin-key',
        },
        body: JSON.stringify({ instruction: 'service run' }),
      }),
      env,
      '/api/orchestrate',
    );

    expect(response.status).toBe(202);
    expect(env.DB.runs).toHaveLength(1);
    expect(env.DB.runs[0]?.owner_id).toBe('orchestration-system');
  });

  it('accepts autopilot bearer auth and reuses the service owner scope', async () => {
    vi.mocked(authenticateBearer).mockReturnValue({ authenticated: true, reason: 'ok' } as any);
    const env = createEnv({
      RUN_COORDINATOR: {
        idFromName: vi.fn((value: string) => value),
        get: vi.fn(() => ({ fetch: vi.fn() })),
      },
    });

    const response = await handleOrchestrateAPI(
      new Request('https://example.com/api/orchestrate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer autopilot-key',
        },
        body: JSON.stringify({ instruction: 'autopilot run' }),
      }),
      env,
      '/api/orchestrate',
    );

    expect(response.status).toBe(202);
    expect(env.DB.runs).toHaveLength(1);
    expect(env.DB.runs[0]?.owner_id).toBe('orchestration-system');
  });

  it('preserves JWT user ownership when user auth is available', async () => {
    vi.mocked(authenticateRequest).mockResolvedValue({
      authenticated: true,
      userId: 'user-123',
      role: 'admin',
    } as any);
    vi.mocked(verifyAPIKey).mockReturnValue(true);
    const env = createEnv();

    const response = await handleOrchestrateAPI(
      new Request('https://example.com/api/orchestrate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer user-jwt',
        },
        body: JSON.stringify({ instruction: 'user run' }),
      }),
      env,
      '/api/orchestrate',
    );

    expect(response.status).toBe(202);
    expect(env.DB.runs[0]?.owner_id).toBe('user-123');
  });

  it('allows admin api key callers to read service-owned runs', async () => {
    vi.mocked(verifyAPIKey).mockReturnValue(true);
    const env = createEnv();

    const createResponse = await handleOrchestrateAPI(
      new Request('https://example.com/api/orchestrate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': 'admin-key',
        },
        body: JSON.stringify({ instruction: 'service run' }),
      }),
      env,
      '/api/orchestrate',
    );

    const createBody = await createResponse.json() as { data: { run_id: string } };

    const getResponse = await handleOrchestrateAPI(
      new Request(`https://example.com/api/runs/${createBody.data.run_id}`, {
        headers: {
          'X-API-Key': 'admin-key',
        },
      }),
      env,
      `/api/runs/${createBody.data.run_id}`,
    );

    expect(getResponse.status).toBe(200);
    const getBody = await getResponse.json() as { data: { owner_id: string } };
    expect(getBody.data.owner_id).toBe('orchestration-system');
  });

  it('prefers live DO state for run detail reads', async () => {
    vi.mocked(verifyAPIKey).mockReturnValue(true);
    vi.mocked(doFetch).mockResolvedValue(new Response(JSON.stringify({
      data: {
        run: {
          run_id: 'run-1',
          status: 'succeeded',
          budget_usd: 1,
          cost_usd: 0.25,
          step_count: 2,
          created_at: '2026-03-09T00:00:00.000Z',
          updated_at: '2026-03-09T00:01:00.000Z',
        },
        steps: [
          {
            seq: 1,
            status: 'succeeded',
            agent: 'codex',
            attempts: 1,
            max_attempts: 3,
            idempotency_key: 'idem-1',
            input: { task: 'a' },
            cost_usd: 0.1,
            started_at: '2026-03-09T00:00:05.000Z',
            completed_at: '2026-03-09T00:00:10.000Z',
            updated_at: '2026-03-09T00:00:10.000Z',
          },
        ],
      },
    })));
    const env = createEnv({
      RUN_COORDINATOR: {
        idFromName: vi.fn((value: string) => value),
        get: vi.fn(() => ({ fetch: vi.fn() })),
      },
    });
    env.DB.runs.push({
      run_id: 'run-1',
      owner_id: 'orchestration-system',
      instruction: 'service run',
      status: 'running',
      budget_usd: 1,
      cost_usd: 0,
      memory_json: '{}',
      step_count: 0,
      max_steps: 1,
      created_at: '2026-03-09T00:00:00.000Z',
      updated_at: '2026-03-09T00:00:00.000Z',
    });

    const response = await handleOrchestrateAPI(
      new Request('https://example.com/api/runs/run-1', {
        headers: { 'X-API-Key': 'admin-key' },
      }),
      env,
      '/api/runs/run-1',
    );

    expect(response.status).toBe(200);
    const json = await response.json() as { data: { status: string; step_count: number; steps: Array<{ step_id: string }> } };
    expect(json.data.status).toBe('succeeded');
    expect(json.data.step_count).toBe(2);
    expect(json.data.steps[0]?.step_id).toBe('run-1:1');
    expect(env.DB.runs[0]?.status).toBe('succeeded');
  });

  it('returns live DO steps for /api/runs/:id/steps', async () => {
    vi.mocked(verifyAPIKey).mockReturnValue(true);
    vi.mocked(doFetch).mockResolvedValue(new Response(JSON.stringify({
      data: {
        run: {
          run_id: 'run-2',
          status: 'running',
          budget_usd: 1,
          cost_usd: 0,
          step_count: 1,
          created_at: '2026-03-09T00:00:00.000Z',
          updated_at: '2026-03-09T00:00:30.000Z',
        },
        steps: [
          {
            seq: 1,
            status: 'running',
            agent: 'codex',
            attempts: 1,
            max_attempts: 3,
            idempotency_key: 'idem-2',
            input: { task: 'b' },
            cost_usd: 0,
            started_at: '2026-03-09T00:00:10.000Z',
            updated_at: '2026-03-09T00:00:10.000Z',
          },
        ],
      },
    })));
    const env = createEnv({
      RUN_COORDINATOR: {
        idFromName: vi.fn((value: string) => value),
        get: vi.fn(() => ({ fetch: vi.fn() })),
      },
    });
    env.DB.runs.push({
      run_id: 'run-2',
      owner_id: 'orchestration-system',
      instruction: 'service run',
      status: 'running',
      budget_usd: 1,
      cost_usd: 0,
      memory_json: '{}',
      step_count: 0,
      max_steps: 1,
      created_at: '2026-03-09T00:00:00.000Z',
      updated_at: '2026-03-09T00:00:00.000Z',
    });

    const response = await handleOrchestrateAPI(
      new Request('https://example.com/api/runs/run-2/steps', {
        headers: { 'X-API-Key': 'admin-key' },
      }),
      env,
      '/api/runs/run-2/steps',
    );

    expect(response.status).toBe(200);
    const json = await response.json() as { data: Array<{ step_id: string; status: string }> };
    expect(json.data).toHaveLength(1);
    expect(json.data[0]?.step_id).toBe('run-2:1');
    expect(json.data[0]?.status).toBe('running');
  });
});
