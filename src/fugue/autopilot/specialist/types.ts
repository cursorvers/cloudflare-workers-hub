import type { RiskTier } from '../types';

export type SpecialistTrustLevel = 'TRUSTED' | 'SEMI_TRUSTED' | 'UNTRUSTED';

export const SPECIALIST_TRUST_LEVELS = Object.freeze({
  TRUSTED: 'TRUSTED' as SpecialistTrustLevel,
  SEMI_TRUSTED: 'SEMI_TRUSTED' as SpecialistTrustLevel,
  UNTRUSTED: 'UNTRUSTED' as SpecialistTrustLevel,
});

export interface SpecialistConfig {
  readonly id: string;
  readonly name: string;
  readonly trustLevel: SpecialistTrustLevel;
  readonly maxRiskTier: RiskTier;
  readonly enabled: boolean;
}

export interface SpecialistRegistry {
  readonly specialists: readonly SpecialistConfig[];
}

export interface DelegationRequest {
  readonly taskDescription: string;
  readonly requiredTrustLevel: SpecialistTrustLevel;
  readonly riskTier: RiskTier;
  readonly traceId: string;
}

export interface DelegationResult {
  readonly specialistId: string;
  readonly status: 'delegated' | 'no-match' | 'disabled';
  readonly reason: string;
}
