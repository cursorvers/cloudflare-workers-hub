import type { PolicyDecision } from '../policy/types';

import type { ToolExecutor, ToolRequest, ToolResult } from './types';

export interface MockToolExecutorConfig {
  readonly defaultLatencyMs?: number;
  readonly shouldFail?: boolean;
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

function freezeResult(result: ToolResult): ToolResult {
  return Object.freeze(result);
}

export class MockToolExecutor implements ToolExecutor {
  private readonly defaultLatencyMs: number;
  private readonly shouldFail: boolean;
  private readonly history: ToolResult[];

  constructor(config: MockToolExecutorConfig = {}) {
    this.defaultLatencyMs = normalizeLatencyMs(config.defaultLatencyMs);
    this.shouldFail = config.shouldFail === true;
    this.history = [];
  }

  async execute(request: ToolRequest, decision: PolicyDecision): Promise<ToolResult> {
    await delay(this.defaultLatencyMs);

    const base = {
      requestId: request.id,
      traceContext: request.traceContext,
      durationMs: this.defaultLatencyMs,
    } as const;

    const result = !decision.allowed
      ? freezeResult({
          ...base,
          status: 'denied',
          policyReason: decision.reason,
        })
      : this.shouldFail
        ? freezeResult({
            ...base,
            status: 'failure',
            error: 'mock execution failed',
          })
        : freezeResult({
            ...base,
            status: 'success',
            data: Object.freeze({
              executed: true,
              tool: request.name,
            }),
          });

    this.history.push(result);
    return result;
  }

  getHistory(): readonly ToolResult[] {
    return Object.freeze([...this.history]);
  }
}
