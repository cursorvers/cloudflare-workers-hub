/**
 * Mock Tool Executor — In-memory simulation for testing.
 *
 * Implements the ToolExecutor interface with configurable latency and failure modes.
 */

import type { PolicyDecision } from '../policy/types';

import {
  type ToolExecutor,
  type ToolRequest,
  type ToolResult,
  ToolResultKind,
  ErrorCode,
  freezeToolResult,
} from './types';

export interface MockToolExecutorConfig {
  readonly defaultLatencyMs?: number;
  readonly shouldFail?: boolean;
  readonly failErrorCode?: Exclude<typeof ErrorCode[keyof typeof ErrorCode], typeof ErrorCode.TIMEOUT>;
}

function normalizeLatencyMs(value?: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value as number));
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function nowIso(): string {
  return new Date().toISOString();
}

export class MockToolExecutor implements ToolExecutor {
  private readonly defaultLatencyMs: number;
  private readonly shouldFail: boolean;
  private readonly failErrorCode: Exclude<typeof ErrorCode[keyof typeof ErrorCode], typeof ErrorCode.TIMEOUT>;
  private readonly history: ToolResult[];

  constructor(config: MockToolExecutorConfig = {}) {
    this.defaultLatencyMs = normalizeLatencyMs(config.defaultLatencyMs);
    this.shouldFail = config.shouldFail === true;
    this.failErrorCode = config.failErrorCode ?? ErrorCode.INTERNAL_ERROR;
    this.history = [];
  }

  async execute(request: ToolRequest, decision: PolicyDecision, _signal?: AbortSignal): Promise<ToolResult> {
    const start = performance.now();
    await delay(this.defaultLatencyMs);
    const durationMs = Math.round(performance.now() - start);

    const base = {
      requestId: request.id,
      traceContext: request.traceContext,
      durationMs,
      completedAt: nowIso(),
    } as const;

    let result: ToolResult;

    if (!decision.allowed) {
      result = freezeToolResult({
        ...base,
        kind: ToolResultKind.DENIED,
        policyReason: decision.reason,
      });
    } else if (this.shouldFail) {
      result = freezeToolResult({
        ...base,
        kind: ToolResultKind.FAILURE,
        errorCode: this.failErrorCode,
        error: 'mock execution failed',
        retryable: this.failErrorCode !== ErrorCode.VALIDATION_ERROR,
      });
    } else {
      result = freezeToolResult({
        ...base,
        kind: ToolResultKind.SUCCESS,
        data: Object.freeze({ executed: true, tool: request.name }),
        executionCost: Object.freeze({
          inputTokens: 0,
          outputTokens: 0,
          estimatedCostUsd: 0,
          specialistId: 'mock',
          pricingTier: 'fixed' as const,
        }),
      });
    }

    this.history.push(result);
    return result;
  }

  getHistory(): readonly ToolResult[] {
    return Object.freeze([...this.history]);
  }
}
