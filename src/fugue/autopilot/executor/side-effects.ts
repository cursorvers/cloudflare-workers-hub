import type { ExecutionPlan, ToolResult } from './types';

export interface SideEffectHandler {
  onSuccess(result: ToolResult, plan: ExecutionPlan): void;
  onFailure(result: ToolResult, plan: ExecutionPlan): void;
  onTimeout(result: ToolResult, plan: ExecutionPlan): void;
  onRetry(result: ToolResult, plan: ExecutionPlan, attempt: number): void;
}

export interface StructuredLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

const DEFAULT_LOGGER: StructuredLogger = {
  info: (message, fields) => console.log(JSON.stringify({ level: 'info', message, ...fields })),
  warn: (message, fields) => console.warn(JSON.stringify({ level: 'warn', message, ...fields })),
  error: (message, fields) => console.error(JSON.stringify({ level: 'error', message, ...fields })),
};

const runDetached = (fn: () => void): void => {
  void Promise.resolve().then(fn).catch(() => {});
};

const logFields = (result: ToolResult, plan: ExecutionPlan): Record<string, unknown> => ({
  requestId: result.requestId,
  kind: result.kind,
  durationMs: result.durationMs,
  specialistId: plan.specialistId,
  timeoutMs: plan.timeoutMs,
  maxAttempts: plan.retryPolicy.maxAttempts,
});

export class LoggingSideEffectHandler implements SideEffectHandler {
  constructor(private readonly logger: StructuredLogger = DEFAULT_LOGGER) {}
  onSuccess(result: ToolResult, plan: ExecutionPlan): void { runDetached(() => this.logger.info('[Executor] success', logFields(result, plan))); }
  onFailure(result: ToolResult, plan: ExecutionPlan): void { runDetached(() => this.logger.error('[Executor] failure', logFields(result, plan))); }
  onTimeout(result: ToolResult, plan: ExecutionPlan): void { runDetached(() => this.logger.warn('[Executor] timeout', logFields(result, plan))); }
  onRetry(result: ToolResult, plan: ExecutionPlan, attempt: number): void {
    // attempt is included for correlation; not all loggers will use it.
    runDetached(() => this.logger.warn('[Executor] retry', { ...logFields(result, plan), attempt }));
  }
}

export class CompositeSideEffectHandler implements SideEffectHandler {
  private readonly handlers: readonly SideEffectHandler[];
  constructor(handlers: readonly SideEffectHandler[]) { this.handlers = Object.freeze([...handlers]); }
  onSuccess(result: ToolResult, plan: ExecutionPlan): void { for (const h of this.handlers) runDetached(() => h.onSuccess(result, plan)); }
  onFailure(result: ToolResult, plan: ExecutionPlan): void { for (const h of this.handlers) runDetached(() => h.onFailure(result, plan)); }
  onTimeout(result: ToolResult, plan: ExecutionPlan): void { for (const h of this.handlers) runDetached(() => h.onTimeout(result, plan)); }
  onRetry(result: ToolResult, plan: ExecutionPlan, attempt: number): void { for (const h of this.handlers) runDetached(() => h.onRetry(result, plan, attempt)); }
}

export const NOOP_SIDE_EFFECT_HANDLER: SideEffectHandler = Object.freeze({
  onSuccess: () => {},
  onFailure: () => {},
  onTimeout: () => {},
  onRetry: (_result: ToolResult, _plan: ExecutionPlan, _attempt: number) => {},
});
