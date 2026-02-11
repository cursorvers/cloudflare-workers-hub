import type { DelegationRequest, DelegationResult, SpecialistConfig, SpecialistRegistry } from './types';
import { SPECIALIST_TRUST_LEVELS } from './types';
const TRUST_RANK = Object.freeze({
  [SPECIALIST_TRUST_LEVELS.TRUSTED]: 0,
  [SPECIALIST_TRUST_LEVELS.SEMI_TRUSTED]: 1,
  [SPECIALIST_TRUST_LEVELS.UNTRUSTED]: 2,
});
function freezeSpecialists(specialists: readonly SpecialistConfig[]): readonly SpecialistConfig[] {
  return Object.freeze(specialists.map((s) => Object.freeze({ ...s })));
}
function satisfiesTrust(actual: SpecialistConfig['trustLevel'], required: SpecialistConfig['trustLevel']): boolean {
  return TRUST_RANK[actual] >= TRUST_RANK[required];
}
function matches(s: SpecialistConfig, r: DelegationRequest): boolean {
  return satisfiesTrust(s.trustLevel, r.requiredTrustLevel) && s.maxRiskTier >= r.riskTier;
}
export const DEFAULT_SPECIALISTS = freezeSpecialists([
  { id: 'codex', name: 'Codex', trustLevel: SPECIALIST_TRUST_LEVELS.TRUSTED, maxRiskTier: 4, enabled: true },
  { id: 'glm', name: 'GLM-4.7', trustLevel: SPECIALIST_TRUST_LEVELS.SEMI_TRUSTED, maxRiskTier: 2, enabled: true },
  { id: 'gemini', name: 'Gemini', trustLevel: SPECIALIST_TRUST_LEVELS.SEMI_TRUSTED, maxRiskTier: 2, enabled: true },
  { id: 'grok', name: 'Grok', trustLevel: SPECIALIST_TRUST_LEVELS.UNTRUSTED, maxRiskTier: 1, enabled: false },
]);
export function createRegistry(specialists: readonly SpecialistConfig[] = DEFAULT_SPECIALISTS): SpecialistRegistry {
  return Object.freeze({ specialists: freezeSpecialists(specialists) });
}
export function findSpecialist(registry: SpecialistRegistry, request: DelegationRequest): DelegationResult {
  const candidates = registry.specialists.filter((s) => matches(s, request));
  const active = candidates.find((s) => s.enabled);
  if (active) {
    return Object.freeze({ specialistId: active.id, status: 'delegated', reason: `delegated to ${active.name}` });
  }
  const disabled = candidates.find((s) => !s.enabled);
  if (disabled) {
    return Object.freeze({ specialistId: disabled.id, status: 'disabled', reason: `${disabled.name} is disabled` });
  }
  return Object.freeze({ specialistId: '', status: 'no-match', reason: 'no specialist matched request' });
}
