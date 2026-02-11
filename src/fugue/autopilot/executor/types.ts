import type { PolicyDecision } from '../policy/types';
import type { EffectType, RiskTier, TraceContext } from '../types';

export const ToolCategory = Object.freeze({
  FILE_READ: 'FILE_READ',
  FILE_WRITE: 'FILE_WRITE',
  GIT: 'GIT',
  DEPLOY: 'DEPLOY',
  AUTH: 'AUTH',
  SHELL: 'SHELL',
  NETWORK: 'NETWORK',
} as const);

export type ToolCategory = (typeof ToolCategory)[keyof typeof ToolCategory];

export interface ToolRequest {
  readonly id: string;
  readonly category: ToolCategory;
  readonly name: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly effects: readonly EffectType[];
  readonly riskTier: RiskTier;
  readonly traceContext: TraceContext;
}

export type ToolResultStatus = 'success' | 'failure' | 'denied';

export interface ToolResult {
  readonly requestId: string;
  readonly status: ToolResultStatus;
  readonly data?: unknown;
  readonly error?: string;
  readonly policyReason?: string;
  readonly traceContext: TraceContext;
  readonly durationMs: number;
}

export interface ToolExecutor {
  execute(request: ToolRequest, decision: PolicyDecision): Promise<ToolResult>;
}
