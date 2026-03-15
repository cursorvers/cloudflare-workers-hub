import { describe, expect, it } from 'vitest';
import { RunStateMachine, type StartRequest } from './run-state-machine';
import type {
  IdempotencyRecord,
  RunState,
  RunStorage,
  StepState,
} from './run-storage';

class InMemoryRunStorage implements RunStorage {
  private run: RunState | null = null;
  private readonly steps = new Map<number, StepState>();
  private readonly idempotency = new Map<string, IdempotencyRecord>();

  async getRun(): Promise<RunState | null> {
    return this.run;
  }

  async putRun(run: RunState): Promise<void> {
    this.run = run;
  }

  async getStep(seq: number): Promise<StepState | null> {
    return this.steps.get(seq) ?? null;
  }

  async putStep(step: StepState): Promise<void> {
    this.steps.set(step.seq, step);
  }

  async listSteps(): Promise<StepState[]> {
    return Array.from(this.steps.values());
  }

  async getIdempotency(key: string): Promise<IdempotencyRecord | null> {
    return this.idempotency.get(key) ?? null;
  }

  async putIdempotency(key: string, record: IdempotencyRecord): Promise<void> {
    this.idempotency.set(key, record);
  }
}

function createStartRequest(): StartRequest {
  return {
    run_id: '11111111-1111-4111-8111-111111111111',
    budget_usd: 1,
    steps: [
      {
        seq: 1,
        agent: 'codex',
        input: { description: 'Draft a single recommendation' },
        max_attempts: 1,
      },
    ],
  };
}

describe('RunStateMachine.handleStart', () => {
  it('does not mark the first step running before alarm-driven execution starts', async () => {
    const storage = new InMemoryRunStorage();
    const sm = new RunStateMachine(storage);

    const result = await sm.handleStart(createStartRequest());
    const storedStep = await storage.getStep(1);
    const storedRun = await storage.getRun();

    expect(result.action.action).toBe('awaiting_step');
    expect(result.action.step?.status).toBe('pending');
    expect(storedRun?.status).toBe('pending');
    expect(storedRun?.current_seq).toBeUndefined();
    expect(storedStep?.status).toBe('pending');
    expect(storedStep?.attempts).toBe(0);
    expect(storedStep?.started_at).toBeUndefined();
  });

  it('allows the first alarm tick to claim and execute the pending step', async () => {
    const storage = new InMemoryRunStorage();
    const sm = new RunStateMachine(storage);

    await sm.handleStart(createStartRequest());
    const driven = await sm.driveRunCollectingIdempotencyHits();
    const storedStep = await storage.getStep(1);
    const storedRun = await storage.getRun();

    expect(driven.action.action).toBe('execute_step');
    if (driven.action.action !== 'execute_step') {
      throw new Error('expected execute_step');
    }
    expect(driven.action.step.seq).toBe(1);
    expect(storedRun?.status).toBe('running');
    expect(storedRun?.current_seq).toBe(1);
    expect(storedStep?.status).toBe('running');
    expect(storedStep?.attempts).toBe(1);
    expect(storedStep?.started_at).toBeTruthy();
  });
});
