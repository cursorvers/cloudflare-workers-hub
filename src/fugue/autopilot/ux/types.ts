import type { PolicyDecision } from '../policy/types';
import type { SafetyState } from '../safety/safety-controller';
import type { BudgetState, RiskTier } from '../types';

export type UxAction = 'auto-execute' | 'confirm-card' | 'human-approval' | 'blocked';

export const UX_ACTIONS = Object.freeze({
  AUTO_EXECUTE: 'auto-execute',
  CONFIRM_CARD: 'confirm-card',
  HUMAN_APPROVAL: 'human-approval',
  BLOCKED: 'blocked',
} as const);

export interface UxResolutionInput {
  readonly riskTier: RiskTier;
  readonly budgetState: BudgetState;
  readonly safetyState: SafetyState;
  readonly policyDecision: PolicyDecision;
}

export interface UxResponse {
  readonly action: UxAction;
  readonly reason: string;
  readonly alternatives: readonly string[];
  readonly requiresUserInput: boolean;
  readonly riskTier: RiskTier;
}
