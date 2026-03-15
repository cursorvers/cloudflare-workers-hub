/**
 * Step Executor - Executes orchestration steps via LLM Gateway
 *
 * FUGUE Orchestration API Day 4
 *
 * Drives the execution loop: pulls steps from RunCoordinator DO,
 * executes them via LLM Gateway, and reports results back.
 *
 * ---------------------------------------------------------------------------
 * Design: Case A (waitUntil loop) with StepExecutionDriver abstraction
 * for future migration to Case B (DO) or Case C (Queue).
 *
 * Execution supports Anthropic-mapped agents plus codex/glm/gemini through
 * provider-specific mappings and safe fallbacks.
 */

import { z } from 'zod';
import type { AgentType } from '../schemas/orchestration';
import type { Env } from '../types';
import type { LlmGateway, CostSnapshot, LlmProvider } from './llm-gateway';
import { LlmGatewayError } from './llm-gateway';
import { safeLog } from '../utils/log-sanitizer';

// =============================================================================
// Constants
// =============================================================================

/** Maximum loop iterations to prevent runaway execution */
const MAX_LOOP_ITERATIONS = 50;

/** Maximum wall-clock time for the execution loop (13 min, leaving 2 min buffer for waitUntil 15 min limit) */
const MAX_EXECUTION_MS = 13 * 60_000;
const STEP_EXECUTION_TIMEOUT_MS = 90_000;

// =============================================================================
// Agent → Provider/Model Mapping
// =============================================================================

interface AgentConfig {
  readonly provider: LlmProvider;
  readonly model: string;
  readonly supported: boolean;
}

const AGENT_CONFIG: Readonly<Record<AgentType, AgentConfig>> = {
  sonnet: { provider: 'anthropic', model: 'claude-sonnet-4-20250514', supported: true },
  haiku: { provider: 'anthropic', model: 'claude-haiku-4-20250414', supported: true },
  opus: { provider: 'anthropic', model: 'claude-sonnet-4-20250514', supported: false },
  codex: { provider: 'openai', model: 'gpt-5.2', supported: true },
  glm: { provider: 'workers_ai', model: '@cf/meta/llama-3.1-8b-instruct', supported: true },
  gemini: { provider: 'workers_ai', model: '@cf/meta/llama-3.1-8b-instruct', supported: true },
};

// =============================================================================
// Public Types
// =============================================================================

export interface StepInput {
  readonly seq: number;
  readonly agent: AgentType;
  readonly input: unknown;
  readonly attempts: number;
  readonly max_attempts: number;
  readonly idempotency_key: string;
}

export interface StepResult {
  readonly status: 'succeeded' | 'failed';
  readonly result?: unknown;
  readonly error?: string;
  readonly cost_usd: number;
}

/** Events emitted during step execution for WebSocket/monitoring */
export interface RunEvent {
  readonly event: string;
  readonly run_id: string;
  readonly seq?: number;
  readonly ts: string;
  readonly data: Record<string, unknown>;
}

export type RunEventHandler = (event: RunEvent) => void;

/** DO /start and /step-complete response action */
export interface DriveAction {
  readonly action: string;
  readonly step?: StepInput;
  readonly status?: string;
  readonly reason?: string;
}

export interface DOResponse {
  readonly success: boolean;
  readonly data?: {
    readonly run: Record<string, unknown>;
    readonly action: DriveAction;
    readonly idempotency_hits?: ReadonlyArray<unknown>;
  };
}

export interface StepExecutorDeps {
  readonly llm: LlmGateway;
  readonly env?: {
    readonly AI?: Env['AI'];
    readonly ANTHROPIC_API_KEY?: string;
    readonly OPENAI_API_KEY?: string;
    readonly ENABLE_OPENAI_API?: string;
  };
  readonly onEvent?: RunEventHandler;
}

interface ResolvedAgentConfig extends AgentConfig {
  readonly fallbackReason?: string;
}

function resolveAgentConfig(
  agent: AgentType,
  env?: StepExecutorDeps['env'],
): ResolvedAgentConfig {
  const config = AGENT_CONFIG[agent];
  if (!config.supported) {
    return config;
  }

  if (config.provider === 'anthropic') {
    if (env?.ANTHROPIC_API_KEY) {
      return config;
    }

    if (env?.AI) {
      return {
        provider: 'workers_ai',
        model: '@cf/meta/llama-3.1-8b-instruct',
        supported: true,
        fallbackReason: 'anthropic_unconfigured_workers_ai_fallback',
      };
    }

    if (env?.OPENAI_API_KEY && env.ENABLE_OPENAI_API === 'true') {
      return {
        provider: 'openai',
        model: 'gpt-5.2',
        supported: true,
        fallbackReason: 'anthropic_unconfigured_openai_fallback',
      };
    }

    return config;
  }

  if (config.provider === 'openai') {
    if (env?.OPENAI_API_KEY && env.ENABLE_OPENAI_API === 'true') {
      return config;
    }

    if (env?.AI) {
      return {
        provider: 'workers_ai',
        model: '@cf/meta/llama-3.1-8b-instruct',
        supported: true,
        fallbackReason: 'openai_unconfigured_workers_ai_fallback',
      };
    }
  }

  return config;
}

// =============================================================================
// Executor
// =============================================================================

export class StepExecutor {
  private readonly llm: LlmGateway;
  private readonly env?: StepExecutorDeps['env'];
  private readonly onEvent: RunEventHandler;

  constructor(deps: Readonly<StepExecutorDeps>) {
    this.llm = deps.llm;
    this.env = deps.env;
    this.onEvent = deps.onEvent ?? (() => {});
  }

  /**
   * Execute a single step via LLM Gateway.
   * Returns a result suitable for DO /step-complete.
   */
  async executeStep(runId: string, step: Readonly<StepInput>): Promise<StepResult> {
    const config = resolveAgentConfig(step.agent, this.env);

    // Unsupported agent → fail immediately
    if (!config.supported) {
      return {
        status: 'failed',
        error: `unsupported_agent: ${step.agent}`,
        cost_usd: 0,
      };
    }

    this.emitEvent(runId, 'run:step_started', step.seq, {
      agent: step.agent,
      attempt: step.attempts,
      provider: config.provider,
      model: config.model,
    });

    try {
      const prompt = buildStepPrompt(step.input);

      if (config.fallbackReason) {
        safeLog.info('[StepExecutor] Falling back from Anthropic agent mapping', {
          runId,
          seq: step.seq,
          agent: step.agent,
          provider: config.provider,
          model: config.model,
          reason: config.fallbackReason,
        });
      }

      const textResult = await withExecutionTimeout(
        this.llm.generateText({
          provider: config.provider,
          model: config.model,
          messages: [
            { role: 'system', content: 'You are a task execution agent. Execute the given task and return results.' },
            { role: 'user', content: prompt },
          ],
          maxTokens: 4096,
          temperature: 0.2,
          requestId: `${runId}:${step.seq}:${step.attempts}`,
        }),
        STEP_EXECUTION_TIMEOUT_MS,
        `step_execution_timeout_ms=${STEP_EXECUTION_TIMEOUT_MS} provider=${config.provider} model=${config.model}`,
      );

      this.emitEvent(runId, 'run:step_completed', step.seq, {
        agent: step.agent,
        status: 'succeeded',
        cost_usd: textResult.costEvent.usd,
        tokens_in: textResult.costEvent.tokens_in,
        tokens_out: textResult.costEvent.tokens_out,
      });

      return {
        status: 'succeeded',
        result: { text: textResult.text, model: config.model },
        cost_usd: textResult.costEvent.usd,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const isRetryable = err instanceof LlmGatewayError
        && (err.code === 'PROVIDER_UNAVAILABLE' || err.code === 'CIRCUIT_OPEN');

      safeLog.warn('[StepExecutor] Step execution failed', {
        runId,
        seq: step.seq,
        agent: step.agent,
        error: errorMsg,
        retryable: isRetryable,
      });

      this.emitEvent(runId, 'run:step_completed', step.seq, {
        agent: step.agent,
        status: 'failed',
        error: errorMsg,
      });

      return {
        status: 'failed',
        error: errorMsg,
        cost_usd: 0,
      };
    }
  }

  /**
   * Drive the execution loop: pull action → execute → report → repeat.
   * Runs inside waitUntil with a time and iteration budget.
   */
  async driveLoop(
    runId: string,
    firstAction: Readonly<DriveAction>,
    reportStepComplete: (seq: number, result: StepResult) => Promise<DriveAction>,
  ): Promise<void> {
    let currentAction = firstAction;
    const startTime = Date.now();

    for (let i = 0; i < MAX_LOOP_ITERATIONS; i++) {
      // Time budget check
      if (Date.now() - startTime > MAX_EXECUTION_MS) {
        safeLog.warn('[StepExecutor] Time limit reached', { runId, iterations: i });
        this.emitEvent(runId, 'run:blocked', undefined, {
          reason: 'time_limit',
          iterations: i,
        });
        return;
      }

      if (currentAction.action === 'execute_step' && currentAction.step) {
        const step = currentAction.step;
        const result = await this.executeStep(runId, step);
        currentAction = await reportStepComplete(step.seq, result);
        continue;
      }

      if (currentAction.action === 'run_done') {
        this.emitEvent(runId, 'run:completed', undefined, {
          status: currentAction.status ?? 'succeeded',
        });
        return;
      }

      if (currentAction.action === 'run_blocked') {
        this.emitEvent(runId, 'run:blocked', undefined, {
          status: currentAction.status ?? 'blocked_error',
          reason: currentAction.reason,
        });
        return;
      }

      if (currentAction.action === 'run_cancelled') {
        this.emitEvent(runId, 'run:cancelled', undefined, {
          reason: currentAction.reason,
        });
        return;
      }

      if (currentAction.action === 'awaiting_step') {
        // Step is still running from a previous attempt (e.g., resumed run).
        // Exit loop; execution will resume when the user calls POST /resume.
        safeLog.info('[StepExecutor] Step still running from prior attempt, exiting', { runId });
        return;
      }

      // Unknown action
      safeLog.warn('[StepExecutor] Unknown action', { runId, action: currentAction.action });
      return;
    }

    safeLog.warn('[StepExecutor] Max iterations reached', { runId });
    this.emitEvent(runId, 'run:blocked', undefined, {
      reason: 'max_iterations',
    });
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  private emitEvent(
    runId: string,
    event: string,
    seq: number | undefined,
    data: Record<string, unknown>,
  ): void {
    this.onEvent({
      event,
      run_id: runId,
      seq,
      ts: new Date().toISOString(),
      data,
    });
  }
}

// =============================================================================
// Pure helpers
// =============================================================================

/**
 * Build a prompt string from step input.
 * Step input can be a structured object with description/data,
 * or a plain string.
 */
function buildStepPrompt(input: unknown): string {
  if (typeof input === 'string') return input;

  if (input && typeof input === 'object') {
    const obj = input as Record<string, unknown>;
    const parts: string[] = [];

    if (typeof obj.description === 'string') {
      parts.push(`Task: ${obj.description}`);
    }
    if (typeof obj.capability === 'string') {
      parts.push(`Capability: ${obj.capability}`);
    }
    if (obj.data !== undefined) {
      try {
        parts.push(`Data: ${JSON.stringify(obj.data)}`);
      } catch {
        parts.push(`Data: ${String(obj.data)}`);
      }
    }

    if (parts.length > 0) return parts.join('\n\n');
  }

  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}

async function withExecutionTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
