import type { RiskTier } from '../types/risk';

export interface AlternativeAction {
  readonly description: string;
  readonly riskTier: RiskTier;
  readonly requiresApproval: boolean;
}

export interface ActionableResponse {
  readonly status: 'executed' | 'denied' | 'needs-input' | 'error';
  readonly summary: string;
  readonly details: string;
  readonly alternatives: readonly AlternativeAction[];
  readonly riskTier: RiskTier;
  readonly traceId: string;
  readonly timestamp: string;
}
