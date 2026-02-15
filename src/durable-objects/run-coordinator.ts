/**
 * RunCoordinator Durable Object (FUGUE Orchestration API)
 *
 * Thin DO shell: routing + alarm-driven step execution.
 * State machine logic delegated to RunStateMachine.
 * Storage IO delegated to DORunStorage.
 *
 * Design: Case B — DO alarm drives step execution via LLM Gateway.
 * Each alarm tick: stuck detection → drive next pending step → schedule next alarm.
 */

import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../types';
import { DORunStorage } from './run-storage';
import {
  RunStateMachine,
  StartRequestSchema,
  StepCompleteRequestSchema,
  CancelRequestSchema,
  ResumeRequestSchema,
  type DriveAction,
} from './run-state-machine';
import { StepExecutor, type StepResult } from '../services/step-executor';
import { LlmGateway } from '../services/llm-gateway';
import { safeLog } from '../utils/log-sanitizer';

// =============================================================================
// Constants
// =============================================================================

const ALARM_INTERVAL_MS = 30_000;
const STUCK_STEP_MS = 5 * 60_000;

// =============================================================================
// Helpers
// =============================================================================

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorResponse(message: string, status: number, code?: string): Response {
  return jsonResponse({ success: false, error: { code: code ?? 'ERROR', message } }, status);
}

// =============================================================================
// Durable Object
// =============================================================================

export class RunCoordinator extends DurableObject<Env> {
  private readonly store: DORunStorage;
  private readonly sm: RunStateMachine;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new DORunStorage(ctx.storage);
    this.sm = new RunStateMachine(this.store);
    this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
  }

  /**
   * Internal HTTP API for run coordination.
   */
  async fetch(request: Request): Promise<Response> {
    // Verify internal bearer token
    const expectedKey =
      this.env.WORKERS_API_KEY ??
      this.env.ASSISTANT_API_KEY ??
      this.env.QUEUE_API_KEY;

    if (expectedKey) {
      const authHeader = request.headers.get('Authorization');
      const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
      if (token !== expectedKey) {
        return errorResponse('Unauthorized', 401, 'UNAUTHORIZED');
      }
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === '/start' && request.method === 'POST') {
        const body = await request.json().catch(() => null);
        if (!body) return errorResponse('Request body must be valid JSON', 400, 'INVALID_BODY');
        const parsed = StartRequestSchema.safeParse(body);
        if (!parsed.success) return errorResponse(parsed.error.message, 400, 'VALIDATION_ERROR');
        const res = await this.sm.handleStart(parsed.data);
        return jsonResponse({ success: true, data: res }, 200);
      }

      if (path === '/step-complete' && request.method === 'POST') {
        const body = await request.json().catch(() => null);
        if (!body) return errorResponse('Request body must be valid JSON', 400, 'INVALID_BODY');
        const parsed = StepCompleteRequestSchema.safeParse(body);
        if (!parsed.success) return errorResponse(parsed.error.message, 400, 'VALIDATION_ERROR');
        const res = await this.sm.handleStepComplete(parsed.data);
        return jsonResponse({ success: true, data: res }, 200);
      }

      if (path === '/state' && request.method === 'GET') {
        const state = await this.sm.handleGetState();
        return jsonResponse({ success: true, data: state }, 200);
      }

      if (path === '/cancel' && request.method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const parsed = CancelRequestSchema.safeParse(body);
        if (!parsed.success) return errorResponse(parsed.error.message, 400, 'VALIDATION_ERROR');
        const res = await this.sm.handleCancel(parsed.data);
        return jsonResponse({ success: true, data: res }, 200);
      }

      if (path === '/resume' && request.method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const parsed = ResumeRequestSchema.safeParse(body);
        if (!parsed.success) return errorResponse(parsed.error.message, 400, 'VALIDATION_ERROR');
        const res = await this.sm.handleResume(parsed.data);
        // Nudge the alarm loop to pick up pending work immediately.
        await this.ctx.storage.setAlarm(Date.now());
        return jsonResponse({ success: true, data: res }, 200);
      }

      return errorResponse('Not found', 404, 'NOT_FOUND');
    } catch (err) {
      console.error('[RunCoordinator] Request error:', err instanceof Error ? err.message : String(err));
      return errorResponse('Internal error', 500, 'INTERNAL_ERROR');
    }
  }

  /**
   * Periodic alarm: stuck detection + step execution.
   * Always schedules next alarm in finally block (GLM recommendation).
   *
   * Flow: stuck detection → drive state machine → if execute_step, run LLM → report back
   */
  async alarm(): Promise<void> {
    try {
      // Phase 1: Stuck detection
      await this.sm.handleStuckDetection(STUCK_STEP_MS);

      // Phase 2: Drive next step if run is active
      const { action } = await this.sm.driveRunCollectingIdempotencyHits();

      if (action.action === 'execute_step' && action.step) {
        await this.executeStepViaLlm(action);
      }
      // run_done / run_blocked / run_cancelled / awaiting_step → no action needed, alarm continues
    } catch (err) {
      safeLog.error('[RunCoordinator] Alarm error', {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      // Always schedule next alarm (critical for reliability)
      await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
    }
  }

  /**
   * Execute a single step via LLM Gateway and report result to state machine.
   * Errors are caught and reported as step failure (retry logic in state machine).
   */
  private async executeStepViaLlm(action: DriveAction): Promise<void> {
    if (action.action !== 'execute_step' || !action.step) return;

    const run = await this.store.getRun();
    const runId = run?.run_id ?? 'unknown';

    try {
      const llm = new LlmGateway(this.env);
      const executor = new StepExecutor({ llm });
      const result = await executor.executeStep(runId, action.step);

      // Report result back to state machine
      await this.sm.handleStepComplete({
        seq: action.step.seq,
        status: result.status,
        result: result.result,
        error: result.error,
        cost_usd: result.cost_usd,
      });

      safeLog.info('[RunCoordinator] Step executed via alarm', {
        runId,
        seq: action.step.seq,
        status: result.status,
        costUsd: result.cost_usd,
      });
    } catch (err) {
      safeLog.error('[RunCoordinator] Step execution failed in alarm', {
        runId,
        seq: action.step.seq,
        error: err instanceof Error ? err.message : String(err),
      });

      // Report failure to state machine for retry handling
      await this.sm.handleStepComplete({
        seq: action.step.seq,
        status: 'failed',
        error: `alarm_execution_error: ${err instanceof Error ? err.message : String(err)}`,
        cost_usd: 0,
      });
    }
  }
}
