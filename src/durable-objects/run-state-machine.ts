/**
 * RunCoordinator State Machine
 *
 * Pure state transition logic, decoupled from DO storage.
 * Accepts RunStorage interface for DI / testability.
 */

import { z } from 'zod';
import type { AgentType } from '../schemas/orchestration';
import { AgentTypeSchema } from '../schemas/orchestration';
import { safeLog } from '../utils/log-sanitizer';
import {
  type RunState,
  type StepState,
  type IdempotencyRecord,
  type IdempotencyHit,
  type RunStorage,
  nowIso,
  hashJson,
} from './run-storage';

// =============================================================================
// Constants
// =============================================================================

export const DEFAULT_MAX_ATTEMPTS = 3;

// =============================================================================
// Action Types (DO response contract)
// =============================================================================

export type DriveAction =
  | { action: 'execute_step'; step: Pick<StepState, 'seq' | 'agent' | 'attempts' | 'max_attempts' | 'idempotency_key' | 'input'> }
  | { action: 'awaiting_step'; step: Pick<StepState, 'seq' | 'status' | 'started_at' | 'attempts' | 'max_attempts'> }
  | { action: 'run_done'; status: string }
  | { action: 'run_blocked'; status: string; reason?: string }
  | { action: 'run_cancelled'; status: string; reason?: string };

export interface DriveResult {
  action: DriveAction;
  idempotency_hits: IdempotencyHit[];
}

// =============================================================================
// Request Schemas (Internal API)
// =============================================================================

export const StartRequestSchema = z.object({
  run_id: z.string().uuid(),
  budget_usd: z.number().nonnegative(),
  cost_usd: z.number().nonnegative().optional(),
  steps: z.array(z.object({
    seq: z.number().int().positive(),
    agent: AgentTypeSchema,
    input: z.unknown(),
    max_attempts: z.number().int().min(1).max(10).optional(),
  })).min(1),
});
export type StartRequest = z.infer<typeof StartRequestSchema>;

export const StepCompleteRequestSchema = z.object({
  seq: z.number().int().positive(),
  status: z.enum(['succeeded', 'failed']),
  result: z.unknown().optional(),
  error: z.string().min(1).max(20_000).optional(),
  cost_usd: z.number().nonnegative().optional(),
});
export type StepCompleteRequest = z.infer<typeof StepCompleteRequestSchema>;

export const CancelRequestSchema = z.object({
  reason: z.string().min(1).max(10_000).optional(),
});
export type CancelRequest = z.infer<typeof CancelRequestSchema>;

// =============================================================================
// State Machine
// =============================================================================

export class RunStateMachine {
  constructor(private readonly store: RunStorage) {}

  // ---------------------------------------------------------------------------
  // handleStart
  // ---------------------------------------------------------------------------

  async handleStart(req: StartRequest): Promise<{ run: RunState; action: DriveAction; idempotency_hits: IdempotencyHit[] }> {
    const { run } = await this.ensureInitialized(req);

    if (run.cost_usd > run.budget_usd) {
      const updated = {
        ...run,
        status: 'blocked_error' as const,
        blocked_reason: `budget_exceeded: cost_usd=${run.cost_usd} > budget_usd=${run.budget_usd}`,
        updated_at: nowIso(),
      };
      await this.store.putRun(updated);
      return {
        run: updated,
        action: { action: 'run_blocked', status: updated.status, reason: updated.blocked_reason },
        idempotency_hits: [],
      };
    }

    const { action, idempotency_hits } = await this.driveRunCollectingIdempotencyHits();
    const latestRun = (await this.store.getRun()) ?? run;
    return { run: latestRun, action, idempotency_hits };
  }

  // ---------------------------------------------------------------------------
  // handleStepComplete
  // ---------------------------------------------------------------------------

  async handleStepComplete(req: StepCompleteRequest): Promise<{ run: RunState; action: DriveAction; idempotency_hits: IdempotencyHit[] }> {
    const run = await this.store.getRun();
    if (!run) {
      return {
        run: syntheticMissingRun(req.seq),
        action: { action: 'run_blocked', status: 'failed', reason: 'Run not initialized' },
        idempotency_hits: [],
      };
    }

    // Terminal states: idempotent acknowledgement
    if (run.status === 'succeeded') {
      return { run, action: { action: 'run_done', status: run.status }, idempotency_hits: [] };
    }
    if (run.status === 'cancelled') {
      return { run, action: { action: 'run_cancelled', status: run.status, reason: run.cancelled_reason }, idempotency_hits: [] };
    }
    if (run.status === 'blocked_error') {
      return { run, action: { action: 'run_blocked', status: run.status, reason: run.blocked_reason }, idempotency_hits: [] };
    }

    const step = await this.store.getStep(req.seq);
    if (!step) {
      return { run, action: { action: 'run_blocked', status: 'blocked_error', reason: `Unknown step seq=${req.seq}` }, idempotency_hits: [] };
    }

    // Already succeeded: accept idempotently
    if (step.status === 'succeeded') {
      const { action, idempotency_hits } = await this.driveRunCollectingIdempotencyHits();
      const latestRun = (await this.store.getRun()) ?? run;
      return { run: latestRun, action, idempotency_hits };
    }

    // Non-running: conflict warning but still drive
    if (step.status !== 'running') {
      safeLog.warn('[RunStateMachine] step-complete for non-running step', { seq: req.seq, status: step.status });
      const { action, idempotency_hits } = await this.driveRunCollectingIdempotencyHits();
      const latestRun = (await this.store.getRun()) ?? run;
      return { run: latestRun, action, idempotency_hits };
    }

    const now = nowIso();

    if (req.status === 'succeeded') {
      const updatedStep: StepState = {
        ...step,
        status: 'succeeded',
        completed_at: now,
        updated_at: now,
        result: req.result,
        cost_usd: step.cost_usd + (Number.isFinite(req.cost_usd ?? 0) && (req.cost_usd ?? 0) > 0 ? req.cost_usd! : 0),
      };
      const deltaCost = updatedStep.cost_usd - step.cost_usd;

      const updatedRun: RunState = {
        ...run,
        cost_usd: run.cost_usd + deltaCost,
        updated_at: now,
        current_seq: undefined,
      };

      // Cache idempotency
      await this.store.putIdempotency(step.idempotency_key, {
        key: step.idempotency_key,
        stored_at: now,
        result: req.result,
      });

      await this.store.putStep(updatedStep);
      await this.store.putRun(updatedRun);

      // Budget guard after cost update
      if (updatedRun.cost_usd > updatedRun.budget_usd) {
        const blockedRun: RunState = {
          ...updatedRun,
          status: 'blocked_error',
          blocked_reason: `budget_exceeded: cost_usd=${updatedRun.cost_usd} > budget_usd=${updatedRun.budget_usd}`,
          updated_at: nowIso(),
        };
        await this.store.putRun(blockedRun);
        return { run: blockedRun, action: { action: 'run_blocked', status: blockedRun.status, reason: blockedRun.blocked_reason }, idempotency_hits: [] };
      }

      const { action, idempotency_hits } = await this.driveRunCollectingIdempotencyHits();
      const latestRun = (await this.store.getRun()) ?? updatedRun;
      return { run: latestRun, action, idempotency_hits };
    }

    // Failed
    const failedStep: StepState = {
      ...step,
      error: req.error ?? 'step_failed',
      completed_at: now,
      updated_at: now,
      status: 'failed',
    };
    await this.store.putStep(failedStep);

    if (failedStep.attempts >= failedStep.max_attempts) {
      const blockedRun: RunState = {
        ...run,
        status: 'blocked_error',
        blocked_reason: `step_failed_max_attempts: seq=${failedStep.seq} attempts=${failedStep.attempts}/${failedStep.max_attempts}`,
        updated_at: nowIso(),
        current_seq: undefined,
      };
      await this.store.putRun(blockedRun);
      return { run: blockedRun, action: { action: 'run_blocked', status: blockedRun.status, reason: blockedRun.blocked_reason }, idempotency_hits: [] };
    }

    // Retry: back to pending
    const retryStep: StepState = {
      ...failedStep,
      status: 'pending',
      started_at: undefined,
      updated_at: nowIso(),
    };
    await this.store.putStep(retryStep);

    const retryRun: RunState = { ...run, updated_at: nowIso(), current_seq: undefined };
    await this.store.putRun(retryRun);

    const { action, idempotency_hits } = await this.driveRunCollectingIdempotencyHits();
    const latestRun = (await this.store.getRun()) ?? retryRun;
    return { run: latestRun, action, idempotency_hits };
  }

  // ---------------------------------------------------------------------------
  // handleGetState
  // ---------------------------------------------------------------------------

  async handleGetState(): Promise<{ run: RunState | null; steps: StepState[] }> {
    const run = await this.store.getRun();
    const steps = await this.store.listSteps();
    steps.sort((a, b) => a.seq - b.seq);
    return { run, steps };
  }

  // ---------------------------------------------------------------------------
  // handleCancel
  // ---------------------------------------------------------------------------

  async handleCancel(req: CancelRequest): Promise<{ run: RunState; steps_updated: number }> {
    const run = await this.store.getRun();
    if (!run) {
      return {
        run: {
          run_id: 'unknown',
          status: 'cancelled',
          budget_usd: 0,
          cost_usd: 0,
          step_count: 0,
          created_at: nowIso(),
          updated_at: nowIso(),
          cancelled_reason: req.reason ?? 'cancelled',
        },
        steps_updated: 0,
      };
    }

    if (run.status === 'cancelled') {
      return { run, steps_updated: 0 };
    }

    const steps = await this.store.listSteps();
    let updated = 0;
    const now = nowIso();
    for (const step of steps) {
      if (step.status === 'succeeded' || step.status === 'failed' || step.status === 'skipped') continue;
      const cancelledStep: StepState = {
        ...step,
        status: 'skipped',
        completed_at: now,
        started_at: step.started_at ?? now,
        updated_at: now,
      };
      await this.store.putStep(cancelledStep);
      updated++;
    }

    const cancelledRun: RunState = {
      ...run,
      status: 'cancelled',
      cancelled_reason: req.reason ?? 'cancelled',
      updated_at: now,
      current_seq: undefined,
    };
    await this.store.putRun(cancelledRun);

    return { run: cancelledRun, steps_updated: updated };
  }

  // ---------------------------------------------------------------------------
  // handleStuckDetection (called by alarm)
  // ---------------------------------------------------------------------------

  async handleStuckDetection(stuckThresholdMs: number): Promise<void> {
    const run = await this.store.getRun();
    if (!run || run.status !== 'running') return;

    const steps = await this.store.listSteps();
    const running = steps.find((s) => s.status === 'running');
    if (!running?.started_at) return;

    const startedAtMs = Date.parse(running.started_at);
    if (!Number.isFinite(startedAtMs)) return;
    if (Date.now() - startedAtMs <= stuckThresholdMs) return;

    const now = nowIso();
    safeLog.warn('[RunStateMachine] Stuck step detected', {
      runId: run.run_id,
      seq: running.seq,
      started_at: running.started_at,
      attempts: running.attempts,
    });

    const failedStep: StepState = {
      ...running,
      status: 'failed',
      error: 'stuck_timeout',
      completed_at: now,
      updated_at: now,
    };
    await this.store.putStep(failedStep);

    if (failedStep.attempts >= failedStep.max_attempts) {
      const blockedRun: RunState = {
        ...run,
        status: 'blocked_error',
        blocked_reason: `stuck_step_max_attempts: seq=${running.seq} attempts=${running.attempts}/${running.max_attempts}`,
        updated_at: now,
        current_seq: undefined,
      };
      await this.store.putRun(blockedRun);
      return;
    }

    // Retry
    const retryStep: StepState = {
      ...failedStep,
      status: 'pending',
      started_at: undefined,
      updated_at: nowIso(),
    };
    await this.store.putStep(retryStep);

    const updatedRun: RunState = { ...run, updated_at: nowIso(), current_seq: undefined };
    await this.store.putRun(updatedRun);
  }

  // ---------------------------------------------------------------------------
  // Core: driveRunCollectingIdempotencyHits
  // ---------------------------------------------------------------------------

  async driveRunCollectingIdempotencyHits(): Promise<DriveResult> {
    const idempotency_hits: IdempotencyHit[] = [];

    while (true) {
      const run = await this.store.getRun();
      if (!run) return { action: { action: 'run_blocked', status: 'failed', reason: 'Run not initialized' }, idempotency_hits };

      if (run.status === 'succeeded') return { action: { action: 'run_done', status: run.status }, idempotency_hits };
      if (run.status === 'cancelled') return { action: { action: 'run_cancelled', status: run.status, reason: run.cancelled_reason }, idempotency_hits };
      if (run.status === 'blocked_error') return { action: { action: 'run_blocked', status: run.status, reason: run.blocked_reason }, idempotency_hits };

      const steps = await this.store.listSteps();
      steps.sort((a, b) => a.seq - b.seq);

      const running = steps.find((s) => s.status === 'running');
      if (running) {
        const updatedRun: RunState = { ...run, current_seq: running.seq, updated_at: nowIso() };
        await this.store.putRun(updatedRun);
        return {
          action: {
            action: 'awaiting_step',
            step: {
              seq: running.seq,
              status: running.status,
              started_at: running.started_at,
              attempts: running.attempts,
              max_attempts: running.max_attempts,
            },
          },
          idempotency_hits,
        };
      }

      const allSucceeded = steps.length > 0 && steps.every((s) => s.status === 'succeeded' || s.status === 'skipped');
      if (allSucceeded) {
        const doneRun: RunState = { ...run, status: 'succeeded', updated_at: nowIso(), current_seq: undefined };
        await this.store.putRun(doneRun);
        return { action: { action: 'run_done', status: doneRun.status }, idempotency_hits };
      }

      const next = steps.find((s) => s.status === 'pending');
      if (!next) {
        return { action: { action: 'run_blocked', status: 'blocked_error', reason: 'No pending steps and run not complete' }, idempotency_hits };
      }

      if (run.cost_usd > run.budget_usd) {
        const blockedRun: RunState = {
          ...run,
          status: 'blocked_error',
          blocked_reason: `budget_exceeded: cost_usd=${run.cost_usd} > budget_usd=${run.budget_usd}`,
          updated_at: nowIso(),
        };
        await this.store.putRun(blockedRun);
        return { action: { action: 'run_blocked', status: blockedRun.status, reason: blockedRun.blocked_reason }, idempotency_hits };
      }

      const cached = await this.store.getIdempotency(next.idempotency_key);
      if (cached) {
        const now = nowIso();
        const cachedStep: StepState = { ...next, status: 'succeeded', result: cached.result, completed_at: now, updated_at: now };
        await this.store.putStep(cachedStep);
        const updatedRun: RunState = { ...run, updated_at: now };
        await this.store.putRun(updatedRun);
        idempotency_hits.push({ seq: next.seq, key: next.idempotency_key, result: cached.result });
        continue;
      }

      const runStatus = run.status === 'pending' ? 'running' : run.status;
      const now = nowIso();
      const startedStep: StepState = { ...next, status: 'running', started_at: now, updated_at: now, attempts: next.attempts + 1 };
      await this.store.putStep(startedStep);

      const activeRun: RunState = { ...run, status: runStatus, current_seq: next.seq, updated_at: now };
      await this.store.putRun(activeRun);

      return {
        action: {
          action: 'execute_step',
          step: {
            seq: next.seq,
            agent: next.agent,
            input: next.input,
            attempts: startedStep.attempts,
            max_attempts: next.max_attempts,
            idempotency_key: next.idempotency_key,
          },
        },
        idempotency_hits,
      };
    }
  }

  // ---------------------------------------------------------------------------
  // ensureInitialized
  // ---------------------------------------------------------------------------

  async ensureInitialized(req: StartRequest): Promise<{ run: RunState; steps: StepState[] }> {
    const existingRun = await this.store.getRun();
    const now = nowIso();

    let run: RunState;
    if (!existingRun) {
      run = {
        run_id: req.run_id,
        status: 'pending',
        budget_usd: req.budget_usd,
        cost_usd: req.cost_usd ?? 0,
        step_count: req.steps.length,
        created_at: now,
        updated_at: now,
      };
      await this.store.putRun(run);
    } else {
      run = { ...existingRun };
      if (Number.isFinite(req.budget_usd) && req.budget_usd !== run.budget_usd) run = { ...run, budget_usd: req.budget_usd };
      if (Number.isFinite(req.cost_usd ?? NaN) && typeof req.cost_usd === 'number' && req.cost_usd > run.cost_usd) run = { ...run, cost_usd: req.cost_usd };
      run = { ...run, updated_at: now };
      await this.store.putRun(run);
    }

    const stepsInStorage = await this.store.listSteps();
    const bySeq = new Map<number, StepState>();
    for (const s of stepsInStorage) bySeq.set(s.seq, s);

    for (const s of req.steps) {
      if (bySeq.has(s.seq)) continue;
      const idemKey = await hashJson(s.input);
      const step: StepState = {
        seq: s.seq,
        status: 'pending',
        agent: s.agent,
        attempts: 0,
        max_attempts: s.max_attempts ?? DEFAULT_MAX_ATTEMPTS,
        idempotency_key: idemKey,
        input: s.input,
        cost_usd: 0,
        updated_at: nowIso(),
      };
      await this.store.putStep(step);
      bySeq.set(step.seq, step);
    }

    const steps = Array.from(bySeq.values());
    steps.sort((a, b) => a.seq - b.seq);

    if (run.step_count !== steps.length) {
      run = { ...run, step_count: steps.length, updated_at: nowIso() };
      await this.store.putRun(run);
    }

    return { run, steps };
  }
}

// =============================================================================
// Helpers
// =============================================================================

function syntheticMissingRun(seq: number): RunState {
  const now = nowIso();
  return {
    run_id: 'unknown',
    status: 'failed',
    budget_usd: 0,
    cost_usd: 0,
    step_count: 0,
    current_seq: seq,
    blocked_reason: 'Run not initialized',
    created_at: now,
    updated_at: now,
  };
}
