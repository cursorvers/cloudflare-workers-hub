import {
  ErrorCode,
  type ExecutionCost,
  type ExecutionPlan,
  type FailureResult,
  type SuccessResult,
  type TimeoutResult,
  type ToolResult,
  ToolResultKind,
  freezeToolResult,
} from './types';

export interface ProviderAdapter { sendRequest(plan: ExecutionPlan, signal?: AbortSignal): Promise<ToolResult>; }

export interface SpecialistEndpointConfig {
  readonly baseUrl: string;
  readonly apiKeyEnvVar: string;
  readonly timeoutMs: number;
  readonly headers?: Readonly<Record<string, string>>;
}

export const DEFAULT_ENDPOINTS: Record<string, SpecialistEndpointConfig> = Object.freeze({
  codex: Object.freeze({ baseUrl: 'https://api.openai.com/v1/responses', apiKeyEnvVar: 'OPENAI_API_KEY', timeoutMs: 30_000, headers: Object.freeze({ 'x-specialist': 'codex' }) }),
  glm: Object.freeze({ baseUrl: 'https://open.bigmodel.cn/api/paas/v4/chat/completions', apiKeyEnvVar: 'ZAI_API_KEY', timeoutMs: 30_000, headers: Object.freeze({ 'x-specialist': 'glm' }) }),
  gemini: Object.freeze({ baseUrl: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent', apiKeyEnvVar: 'GEMINI_API_KEY', timeoutMs: 30_000, headers: Object.freeze({ 'x-specialist': 'gemini' }) }),
});

interface HttpProviderAdapterOptions {
  readonly endpoints?: Readonly<Record<string, SpecialistEndpointConfig>>;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetchImpl?: typeof fetch;
}

const nowIso = (): string => new Date().toISOString();
const asNumber = (value: unknown, fallback = 0): number => {
  const num = typeof value === 'number' ? value : Number(value);
  return isFinite(num) ? num : fallback;
};

function pickUsage(body: unknown): { inputTokens: number; outputTokens: number } {
  const usage = (body as { usage?: Record<string, unknown> } | null)?.usage ?? {};
  return { inputTokens: asNumber(usage.input_tokens ?? usage.prompt_tokens ?? usage.promptTokens), outputTokens: asNumber(usage.output_tokens ?? usage.completion_tokens ?? usage.completionTokens) };
}

function extractExecutionCost(specialistId: string, headers: Headers, body: unknown): ExecutionCost {
  const usage = pickUsage(body);
  const inputTokens = usage.inputTokens || asNumber(headers.get('x-input-tokens') ?? headers.get('x-prompt-tokens'));
  const outputTokens = usage.outputTokens || asNumber(headers.get('x-output-tokens') ?? headers.get('x-completion-tokens'));
  const estimatedCostUsd = asNumber((body as { estimatedCostUsd?: unknown } | null)?.estimatedCostUsd ?? headers.get('x-estimated-cost-usd'));
  const pricingTier = ((body as { pricingTier?: unknown } | null)?.pricingTier as ExecutionCost['pricingTier']) ?? ((headers.get('x-pricing-tier') as ExecutionCost['pricingTier'] | null) ?? 'per_token');
  return Object.freeze({ inputTokens, outputTokens, estimatedCostUsd, specialistId, pricingTier: pricingTier === 'fixed' ? 'fixed' : 'per_token' });
}

function toFailure(plan: ExecutionPlan, startedAt: number, errorCode: FailureResult['errorCode'], error: string, retryable: boolean): ToolResult {
  return freezeToolResult({ requestId: plan.request.id, kind: ToolResultKind.FAILURE, traceContext: plan.request.traceContext, durationMs: Math.round(performance.now() - startedAt), completedAt: nowIso(), errorCode, error, retryable });
}

function toTimeout(plan: ExecutionPlan, startedAt: number, timeoutMs: number): TimeoutResult {
  return freezeToolResult({ requestId: plan.request.id, kind: ToolResultKind.TIMEOUT, traceContext: plan.request.traceContext, durationMs: Math.round(performance.now() - startedAt), completedAt: nowIso(), errorCode: ErrorCode.TIMEOUT, timeoutMs, error: `request timed out after ${timeoutMs}ms`, retryable: true }) as TimeoutResult;
}

const parseBodyText = (text: string): unknown => {
  if (!text) return Object.freeze({});
  return JSON.parse(text) as unknown;
};

function mergeSignals(timeoutMs: number, external?: AbortSignal): { signal: AbortSignal; timedOut: () => boolean } {
  const timeoutSignal = AbortSignal.timeout(Math.max(1, timeoutMs));
  const controller = new AbortController();
  const forward = (source: AbortSignal): void => { if (!controller.signal.aborted) controller.abort(source.reason); };
  timeoutSignal.addEventListener('abort', () => forward(timeoutSignal), { once: true });
  external?.addEventListener('abort', () => forward(external), { once: true });
  return { signal: controller.signal, timedOut: () => timeoutSignal.aborted };
}

export class HttpProviderAdapter implements ProviderAdapter {
  private readonly endpoints: Readonly<Record<string, SpecialistEndpointConfig>>;
  private readonly env: Readonly<Record<string, string | undefined>>;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpProviderAdapterOptions = {}) {
    this.endpoints = options.endpoints ?? DEFAULT_ENDPOINTS;
    this.env = options.env ?? ((globalThis as { process?: { env?: Record<string, string> } }).process?.env ?? {});
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async sendRequest(plan: ExecutionPlan, signal?: AbortSignal): Promise<ToolResult> {
    const startedAt = performance.now();
    const endpoint = this.endpoints[plan.specialistId];
    if (!endpoint) return toFailure(plan, startedAt, ErrorCode.VALIDATION_ERROR, `unknown specialist: ${plan.specialistId}`, false);

    const apiKey = this.env[endpoint.apiKeyEnvVar];
    if (!apiKey) return toFailure(plan, startedAt, ErrorCode.INTERNAL_ERROR, `missing API key: ${endpoint.apiKeyEnvVar}`, false);

    const timeoutMs = Math.max(1, Math.floor(plan.timeoutMs || endpoint.timeoutMs));
    const merged = mergeSignals(timeoutMs, signal);
    const headers: Record<string, string> = { 'content-type': 'application/json', authorization: `Bearer ${apiKey}`, 'x-idempotency-key': plan.idempotencyKey, ...endpoint.headers };

    try {
      const response = await this.fetchImpl(endpoint.baseUrl, { method: 'POST', headers, body: JSON.stringify({ request: plan.request, decision: plan.decision, idempotencyKey: plan.idempotencyKey }), signal: merged.signal });
      let body: unknown;
      try {
        body = parseBodyText(await response.text());
      } catch {
        return toFailure(plan, startedAt, ErrorCode.PROVIDER_ERROR, 'invalid JSON response', true);
      }
      if (response.ok) {
        const result: SuccessResult = { requestId: plan.request.id, kind: ToolResultKind.SUCCESS, traceContext: plan.request.traceContext, durationMs: Math.round(performance.now() - startedAt), completedAt: nowIso(), data: Object.freeze((body as { data?: unknown }).data ?? body), executionCost: extractExecutionCost(plan.specialistId, response.headers, body) };
        return freezeToolResult(result);
      }

      const message = (body as { error?: { message?: string }; message?: string } | null)?.error?.message ?? (body as { message?: string } | null)?.message ?? `HTTP ${response.status}`;
      if (response.status === 429) return toFailure(plan, startedAt, ErrorCode.RATE_LIMITED, message, true);
      if (response.status >= 500) return toFailure(plan, startedAt, ErrorCode.PROVIDER_ERROR, message, true);
      if (response.status >= 400) return toFailure(plan, startedAt, ErrorCode.VALIDATION_ERROR, message, false);
      return toFailure(plan, startedAt, ErrorCode.PROVIDER_ERROR, message, true);
    } catch (error) {
      if (merged.timedOut()) return toTimeout(plan, startedAt, timeoutMs);
      if (signal?.aborted) return toFailure(plan, startedAt, ErrorCode.INTERNAL_ERROR, 'request aborted', false);
      return toFailure(plan, startedAt, ErrorCode.PROVIDER_ERROR, error instanceof Error ? error.message : 'provider request failed', true);
    }
  }
}
