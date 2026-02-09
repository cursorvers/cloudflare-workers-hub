/**
 * LLM Gateway - Unified interface for multiple LLM providers
 *
 * FUGUE Orchestration API Day 3
 *
 * Provides a single entry point for calling Anthropic, Workers AI, and OpenAI
 * with circuit-breaker protection and cost tracking per call.
 *
 * ---------------------------------------------------------------------------
 * Supported providers:
 * - anthropic: Claude Sonnet / Haiku via ANTHROPIC_API_KEY
 * - workers_ai: Cloudflare Workers AI via env.AI binding
 * - openai: GPT models via OPENAI_API_KEY
 *
 * ---------------------------------------------------------------------------
 * Design: Case A (single-file, unified gateway)
 * - Each provider is a private method
 * - CircuitBreaker is keyed by "provider:model"
 * - Cost is calculated from token counts using per-model pricing
 */

import { z } from 'zod';
import { CircuitBreaker, CircuitOpenError } from '../utils/circuit-breaker';
import { safeLog } from '../utils/log-sanitizer';
import type { Env } from '../types';

// =============================================================================
// Constants
// =============================================================================

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';

const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_TEMPERATURE = 0.2;

/** USD per million tokens (input, output) */
const PRICING: Readonly<Record<string, Readonly<{ in: number; out: number }>>> = {
  'claude-sonnet-4-20250514': { in: 3, out: 15 },
  'claude-haiku-4-20250414': { in: 0.25, out: 1.25 },
  '@cf/meta/llama-3.1-8b-instruct': { in: 0.01, out: 0.01 },
  'gpt-4o-mini': { in: 0.15, out: 0.60 },
  'gpt-5.2': { in: 2, out: 8 },
};

const FALLBACK_PRICING: Readonly<{ in: number; out: number }> = { in: 1, out: 3 };

// =============================================================================
// Public Types
// =============================================================================

export const LlmProviderSchema = z.enum(['anthropic', 'workers_ai', 'openai']);
export type LlmProvider = z.infer<typeof LlmProviderSchema>;

export const LlmMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string(),
});
export type LlmMessage = z.infer<typeof LlmMessageSchema>;

export const LlmRequestSchema = z.object({
  provider: LlmProviderSchema,
  model: z.string().min(1),
  messages: z.array(LlmMessageSchema).min(1),
  maxTokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  requestId: z.string().optional(),
});
export type LlmRequest = z.infer<typeof LlmRequestSchema>;

export interface CostSnapshot {
  readonly provider: string;
  readonly model: string;
  readonly tokens_in: number;
  readonly tokens_out: number;
  readonly usd: number;
}

export interface LlmJsonResult<T> {
  readonly output: T;
  readonly rawText: string;
  readonly costEvent: CostSnapshot;
}

export interface LlmTextResult {
  readonly text: string;
  readonly costEvent: CostSnapshot;
}

// =============================================================================
// Error
// =============================================================================

export class LlmGatewayError extends Error {
  readonly code: string;
  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'LlmGatewayError';
    this.code = code;
  }
}

// =============================================================================
// Internal response types (per-provider)
// =============================================================================

interface AnthropicUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
}

interface AnthropicResponse {
  readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
  readonly usage: AnthropicUsage;
}

interface OpenAIChoice {
  readonly message: { readonly content: string | null };
}

interface OpenAIResponse {
  readonly choices: ReadonlyArray<OpenAIChoice>;
  readonly usage?: {
    readonly prompt_tokens: number;
    readonly completion_tokens: number;
  };
}

interface WorkersAiResponse {
  readonly response?: string;
}

// =============================================================================
// Gateway
// =============================================================================

export class LlmGateway {
  private readonly env: Env;
  private readonly breakers: Map<string, CircuitBreaker> = new Map();

  constructor(env: Env) {
    this.env = env;
  }

  /**
   * Generate structured JSON output and validate with a Zod schema.
   */
  async generateJson<T>(
    req: Readonly<LlmRequest>,
    schema: z.ZodType<T>,
  ): Promise<LlmJsonResult<T>> {
    const textResult = await this.generateText(req);

    const jsonStr = extractJson(textResult.text);
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      throw new LlmGatewayError(
        'INVALID_RESPONSE',
        `Failed to parse JSON from LLM output: ${jsonStr.slice(0, 200)}`,
      );
    }

    const validated = schema.safeParse(parsed);
    if (!validated.success) {
      throw new LlmGatewayError(
        'SCHEMA_VIOLATION',
        `LLM output did not match schema: ${validated.error.message}`,
      );
    }

    return {
      output: validated.data,
      rawText: textResult.text,
      costEvent: textResult.costEvent,
    };
  }

  /**
   * Generate raw text output from an LLM provider.
   */
  async generateText(req: Readonly<LlmRequest>): Promise<LlmTextResult> {
    const validated = LlmRequestSchema.safeParse(req);
    if (!validated.success) {
      throw new LlmGatewayError('VALIDATION_ERROR', validated.error.message);
    }

    const { provider, model } = validated.data;
    const breaker = this.getBreaker(`${provider}:${model}`);

    try {
      return await breaker.execute(() => this.dispatch(validated.data));
    } catch (err) {
      if (err instanceof CircuitOpenError) {
        throw new LlmGatewayError('CIRCUIT_OPEN', err.message, { cause: err });
      }
      throw err;
    }
  }

  // ===========================================================================
  // Provider dispatch
  // ===========================================================================

  private async dispatch(req: LlmRequest): Promise<LlmTextResult> {
    switch (req.provider) {
      case 'anthropic':
        return this.callAnthropic(req);
      case 'workers_ai':
        return this.callWorkersAi(req);
      case 'openai':
        return this.callOpenAi(req);
      default:
        throw new LlmGatewayError('UNSUPPORTED_PROVIDER', `Unknown provider: ${String(req.provider)}`);
    }
  }

  // ===========================================================================
  // Anthropic
  // ===========================================================================

  private async callAnthropic(req: LlmRequest): Promise<LlmTextResult> {
    const apiKey = this.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new LlmGatewayError('PROVIDER_ERROR', 'ANTHROPIC_API_KEY not configured');
    }

    const systemMsg = req.messages.find((m) => m.role === 'system');
    const nonSystemMsgs = req.messages.filter((m) => m.role !== 'system');

    const body = {
      model: req.model,
      max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
      temperature: req.temperature ?? DEFAULT_TEMPERATURE,
      ...(systemMsg ? { system: systemMsg.content } : {}),
      messages: nonSystemMsgs.map((m) => ({ role: m.role, content: m.content })),
    };

    const res = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => 'unknown');
      const code = res.status >= 500 ? 'PROVIDER_UNAVAILABLE' : 'PROVIDER_ERROR';
      throw new LlmGatewayError(code, `Anthropic ${res.status}: ${errText.slice(0, 500)}`);
    }

    const data = (await res.json()) as AnthropicResponse;
    const text = data.content
      .filter((c) => c.type === 'text' && c.text)
      .map((c) => c.text)
      .join('');

    const costEvent = calculateCost(
      req.provider,
      req.model,
      data.usage.input_tokens,
      data.usage.output_tokens,
    );

    safeLog.info('[LlmGateway] Anthropic call', {
      model: req.model,
      tokens_in: costEvent.tokens_in,
      tokens_out: costEvent.tokens_out,
      usd: costEvent.usd,
    });

    return { text, costEvent };
  }

  // ===========================================================================
  // Workers AI
  // ===========================================================================

  private async callWorkersAi(req: LlmRequest): Promise<LlmTextResult> {
    if (!this.env.AI) {
      throw new LlmGatewayError('PROVIDER_ERROR', 'Workers AI (env.AI) not available');
    }

    const response = await (this.env.AI.run as (model: string, input: unknown) => Promise<unknown>)(
      req.model,
      {
        messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
        max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
        temperature: req.temperature ?? DEFAULT_TEMPERATURE,
      },
    );

    // Runtime validation: Workers AI response shape varies by model
    if (!response || typeof response !== 'object') {
      throw new LlmGatewayError('INVALID_RESPONSE', 'Workers AI returned non-object response');
    }
    const text = (response as WorkersAiResponse).response ?? '';
    // Workers AI does not return token counts; estimate from character length.
    const estimatedIn = Math.ceil(
      req.messages.reduce((sum, m) => sum + m.content.length, 0) / 4,
    );
    const estimatedOut = Math.ceil(text.length / 4);

    const costEvent = calculateCost(req.provider, req.model, estimatedIn, estimatedOut);

    safeLog.info('[LlmGateway] Workers AI call', {
      model: req.model,
      tokens_in: costEvent.tokens_in,
      tokens_out: costEvent.tokens_out,
    });

    return { text, costEvent };
  }

  // ===========================================================================
  // OpenAI
  // ===========================================================================

  private async callOpenAi(req: LlmRequest): Promise<LlmTextResult> {
    const apiKey = this.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new LlmGatewayError('PROVIDER_ERROR', 'OPENAI_API_KEY not configured');
    }

    const maxTokens = req.maxTokens ?? DEFAULT_MAX_TOKENS;
    const isNewModel = /^(gpt-[5-9]|o[1-9])/.test(req.model);
    const body = {
      model: req.model,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      ...(isNewModel ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens }),
      temperature: req.temperature ?? DEFAULT_TEMPERATURE,
    };

    const res = await fetch(OPENAI_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => 'unknown');
      const code = res.status >= 500 ? 'PROVIDER_UNAVAILABLE' : 'PROVIDER_ERROR';
      throw new LlmGatewayError(code, `OpenAI ${res.status}: ${errText.slice(0, 500)}`);
    }

    const data = (await res.json()) as OpenAIResponse;
    const text = data.choices[0]?.message?.content ?? '';
    const tokensIn = data.usage?.prompt_tokens ?? 0;
    const tokensOut = data.usage?.completion_tokens ?? 0;

    const costEvent = calculateCost(req.provider, req.model, tokensIn, tokensOut);

    safeLog.info('[LlmGateway] OpenAI call', {
      model: req.model,
      tokens_in: costEvent.tokens_in,
      tokens_out: costEvent.tokens_out,
      usd: costEvent.usd,
    });

    return { text, costEvent };
  }

  // ===========================================================================
  // CircuitBreaker factory
  // ===========================================================================

  private getBreaker(key: string): CircuitBreaker {
    const existing = this.breakers.get(key);
    if (existing) return existing;

    const breaker = new CircuitBreaker(key, {
      failureThreshold: 3,
      resetTimeoutMs: 60_000,
      successThreshold: 1,
    });
    this.breakers.set(key, breaker);
    return breaker;
  }
}

// =============================================================================
// Pure helpers
// =============================================================================

function calculateCost(
  provider: string,
  model: string,
  tokensIn: number,
  tokensOut: number,
): CostSnapshot {
  const pricing = PRICING[model] ?? FALLBACK_PRICING;
  const usd = (tokensIn * pricing.in + tokensOut * pricing.out) / 1_000_000;

  return {
    provider,
    model,
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    usd: Math.round(usd * 1_000_000) / 1_000_000, // 6 decimal places
  };
}

/**
 * Extract JSON from LLM text output.
 * Handles markdown code fences and raw JSON.
 */
function extractJson(text: string): string {
  // Try markdown code fence first
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) return fenceMatch[1].trim();

  // Try raw JSON (first { to last })
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return text.slice(firstBrace, lastBrace + 1);
  }

  // Return as-is (will likely fail JSON.parse)
  return text.trim();
}
