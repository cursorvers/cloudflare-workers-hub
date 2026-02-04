/**
 * AI Agent Usage Types
 * Used to display usage limits in DaemonStatus component
 */

export type UsagePeriod = 'daily' | 'weekly' | 'monthly' | '5h_rolling' | 'monthly_web';

export interface UsageQuota {
  period: UsagePeriod;
  used: number;
  limit: number;
  budget?: string;
  resetAt?: string;
}

export interface AgentUsage {
  quotas: UsageQuota[];
  critical?: UsageQuota;
  lastUpdated?: string;
  source: 'api' | 'manual' | 'cached';
}

export interface UsageResponse {
  timestamp: string;
  agents: {
    claude?: AgentUsage;
    codex?: AgentUsage;
    glm?: AgentUsage;
    gemini?: AgentUsage;
  };
  cacheHit: boolean;
}

export interface UsageViewModel {
  agent: 'claude' | 'codex' | 'glm' | 'gemini';
  agentLabel: string;
  criticalQuota: UsageQuota;
  allQuotas: UsageQuota[];
  percent: number;
  remaining: number;
  status: 'ok' | 'warn' | 'critical';
  expanded: boolean;
}
