/**
 * Task Pack Generator - Instruction decomposition into executable steps
 *
 * FUGUE Orchestration API Day 3
 *
 * Takes an instruction string and uses the LLM Gateway to decompose it
 * into a sequence of steps compatible with RunCoordinator DO /start.
 *
 * ---------------------------------------------------------------------------
 * Flow:
 *   instruction + context
 *       -> LLM Gateway (generateJson)
 *       -> RawTaskPack (LLM output)
 *       -> DelegationMatrix (capability -> AgentType)
 *       -> TaskPack (RunCoordinator /start compatible)
 *
 * ---------------------------------------------------------------------------
 * The DelegationMatrix maps capabilities to agent types based on risk level,
 * mirroring the delegation-matrix.md SSOT.
 */

import { z } from 'zod';
import type { AgentType } from '../schemas/orchestration';
import type { LlmGateway, CostSnapshot } from './llm-gateway';
import { safeLog } from '../utils/log-sanitizer';

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_MAX_STEPS = 20;
const MAX_STEPS_LIMIT = 50;

// MVP policy: Sonnet-only decomposition (single-model to simplify ops/quality).
const DEFAULT_DECOMPOSE_MODEL = 'claude-sonnet-4-20250514';
const DEFAULT_DECOMPOSE_PROVIDER = 'anthropic' as const;

// =============================================================================
// Public Types
// =============================================================================

export const TaskPackInputSchema = z.object({
  instruction: z.string().min(1).max(10_000),
  context: z.unknown().optional(),
  maxSteps: z.number().int().positive().max(MAX_STEPS_LIMIT).optional(),
  requestId: z.string().optional(),
});
export type TaskPackInput = z.infer<typeof TaskPackInputSchema>;

/** Step format compatible with RunCoordinator /start */
export interface TaskPackStep {
  readonly seq: number;
  readonly agent: AgentType;
  readonly input: unknown;
  readonly max_attempts?: number;
}

export interface TaskPack {
  readonly steps: ReadonlyArray<TaskPackStep>;
  readonly rationale?: string;
  readonly warnings?: ReadonlyArray<string>;
  readonly costEvent: CostSnapshot;
}

export interface DelegationMatrix {
  pickAgent(hint: Readonly<{ capability: string; risk?: 'low' | 'med' | 'high' }>): AgentType;
}

export interface TaskPackGeneratorDeps {
  readonly llm: LlmGateway;
  readonly delegation: DelegationMatrix;
}

// =============================================================================
// Error
// =============================================================================

export class TaskPackError extends Error {
  readonly code: string;
  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TaskPackError';
    this.code = code;
  }
}

// =============================================================================
// LLM Output Schema (raw, before agent assignment)
// =============================================================================

const RiskSchema = z.enum(['low', 'med', 'high']);

const RawStepSchema = z.object({
  seq: z.number().int().positive(),
  capability: z.string().min(1),
  description: z.string().min(1),
  input: z.unknown(),
  risk: RiskSchema.default('low'),
  max_attempts: z.number().int().min(1).max(5).default(3),
});

const RawTaskPackSchema = z.object({
  steps: z.array(RawStepSchema).min(1),
  rationale: z.string().optional(),
  warnings: z.array(z.string()).optional(),
});
type RawTaskPack = z.infer<typeof RawTaskPackSchema>;

// =============================================================================
// Default Delegation Matrix
// =============================================================================

const AGENT_MAP: Readonly<
  Record<string, Readonly<{ normal: AgentType; high: AgentType }>>
> = {
  code: { normal: 'sonnet', high: 'sonnet' },
  review: { normal: 'sonnet', high: 'sonnet' },
  search: { normal: 'sonnet', high: 'sonnet' },
  summarize: { normal: 'sonnet', high: 'sonnet' },
  classify: { normal: 'sonnet', high: 'sonnet' },
  security: { normal: 'sonnet', high: 'sonnet' },
  ui: { normal: 'sonnet', high: 'sonnet' },
  design: { normal: 'sonnet', high: 'sonnet' },
};

const DEFAULT_AGENT: Readonly<{ normal: AgentType; high: AgentType }> = {
  normal: 'sonnet',
  high: 'sonnet',
};

export function createDefaultDelegationMatrix(): DelegationMatrix {
  return {
    pickAgent(hint) {
      const entry = AGENT_MAP[hint.capability] ?? DEFAULT_AGENT;
      return hint.risk === 'high' ? entry.high : entry.normal;
    },
  };
}

// =============================================================================
// System Prompt
// =============================================================================

function buildSystemPrompt(maxSteps: number): string {
  return `You are a task decomposition engine for an orchestration system.
Given an instruction, decompose it into sequential execution steps.

Output ONLY valid JSON matching this exact schema:
{
  "steps": [
    {
      "seq": 1,
      "capability": "code|review|search|summarize|classify|security|ui|design",
      "description": "Human-readable step description",
      "input": { "task": "step-specific input data" },
      "risk": "low|med|high",
      "max_attempts": 3
    }
  ],
  "rationale": "Brief explanation of decomposition logic",
  "warnings": ["Optional warnings about edge cases"]
}

Rules:
- Steps execute sequentially in seq order
- Each step should be independently executable by an AI agent
- Minimize step count (max ${maxSteps} steps, prefer fewer comprehensive steps)
- Mark security/payment/auth steps as risk "high"
- Mark routine code/review steps as risk "low"
- max_attempts: 1 for idempotent ops, 3 for standard, 5 for flaky external calls
- capability must be one of: code, review, search, summarize, classify, security, ui, design
- input must contain enough context for an agent to execute without the original instruction
- Do not include meta-steps like "plan" or "think" - only actionable steps`;
}

// =============================================================================
// Generator
// =============================================================================

export class TaskPackGenerator {
  private readonly llm: LlmGateway;
  private readonly delegation: DelegationMatrix;

  constructor(deps: Readonly<TaskPackGeneratorDeps>) {
    this.llm = deps.llm;
    this.delegation = deps.delegation;
  }

  /**
   * Decompose an instruction into a RunCoordinator-compatible TaskPack.
   */
  async generate(input: Readonly<TaskPackInput>): Promise<TaskPack> {
    const validated = TaskPackInputSchema.safeParse(input);
    if (!validated.success) {
      throw new TaskPackError('VALIDATION_ERROR', validated.error.message);
    }

    const { instruction, context, requestId } = validated.data;
    const maxSteps = validated.data.maxSteps ?? DEFAULT_MAX_STEPS;

    let contextStr = '';
    if (context !== undefined) {
      try {
        contextStr = JSON.stringify(context);
      } catch {
        contextStr = String(context);
      }
    }
    const userContent = contextStr
      ? `Instruction: ${instruction}\n\nContext: ${contextStr}`
      : `Instruction: ${instruction}`;

    const rawPack = await this.callLlm(userContent, maxSteps, requestId);
    return this.transformToTaskPack(rawPack.output, rawPack.costEvent, maxSteps);
  }

  // ===========================================================================
  // LLM call
  // ===========================================================================

  private async callLlm(
    userContent: string,
    maxSteps: number,
    requestId?: string,
  ): Promise<{ output: RawTaskPack; costEvent: CostSnapshot }> {
    try {
      const result = await this.llm.generateJson<RawTaskPack>(
        {
          provider: DEFAULT_DECOMPOSE_PROVIDER,
          model: DEFAULT_DECOMPOSE_MODEL,
          messages: [
            { role: 'system', content: buildSystemPrompt(maxSteps) },
            { role: 'user', content: userContent },
          ],
          maxTokens: 4096,
          temperature: 0.1,
          requestId,
        },
        RawTaskPackSchema as z.ZodType<RawTaskPack>,
      );

      return { output: result.output, costEvent: result.costEvent };
    } catch (err) {
      throw new TaskPackError(
        'LLM_FAILED',
        `Task decomposition failed: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }

  // ===========================================================================
  // Transform raw LLM output to TaskPack
  // ===========================================================================

  private transformToTaskPack(
    raw: RawTaskPack,
    costEvent: CostSnapshot,
    maxSteps: number,
  ): TaskPack {
    if (raw.steps.length === 0) {
      throw new TaskPackError('EMPTY_STEPS', 'LLM returned zero steps');
    }

    let warnings: ReadonlyArray<string> = [...(raw.warnings ?? [])];

    // Truncate to maxSteps if needed
    let truncatedSteps = raw.steps;
    if (raw.steps.length > maxSteps) {
      warnings = [...warnings, `Truncated from ${raw.steps.length} to ${maxSteps} steps`];
      truncatedSteps = raw.steps.slice(0, maxSteps);
    }

    // Assign agents via delegation matrix and re-number seq
    const steps: ReadonlyArray<TaskPackStep> = truncatedSteps.map(
      (step, idx) => ({
        seq: idx + 1,
        agent: this.delegation.pickAgent({
          capability: step.capability,
          risk: step.risk,
        }),
        input: {
          capability: step.capability,
          description: step.description,
          data: step.input,
        },
        max_attempts: step.max_attempts,
      }),
    );

    safeLog.info('[TaskPackGenerator] Generated task pack', {
      stepCount: steps.length,
      capabilities: truncatedSteps.map((s) => s.capability),
      agents: steps.map((s) => s.agent),
    });

    return {
      steps,
      rationale: raw.rationale,
      warnings: warnings.length > 0 ? warnings : undefined,
      costEvent,
    };
  }
}
