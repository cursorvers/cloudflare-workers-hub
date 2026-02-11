import { describe, expect, it } from 'vitest';

import { createFeatureFlags } from '../../config/feature-flags';
import type { DelegationRequest } from '../types';
import { SPECIALIST_TRUST_LEVELS } from '../types';
import { DEFAULT_SPECIALISTS, createRegistry, findSpecialist } from '../registry';

function makeRequest(overrides: Partial<DelegationRequest> = {}): DelegationRequest {
  const base: DelegationRequest = {
    taskDescription: 'step 10 specialist delegation',
    requiredTrustLevel: SPECIALIST_TRUST_LEVELS.TRUSTED,
    riskTier: 0,
    traceId: 'trace-specialist-1',
  };
  return Object.freeze({ ...base, ...overrides });
}

describe('specialist/registry', () => {
  it('has 4 default specialists', () => {
    const registry = createRegistry();
    expect(registry.specialists).toHaveLength(4);
  });

  it('delegates to codex for TRUSTED tier 3', () => {
    const registry = createRegistry();
    const result = findSpecialist(
      registry,
      makeRequest({ requiredTrustLevel: SPECIALIST_TRUST_LEVELS.TRUSTED, riskTier: 3 }),
    );
    expect(result.status).toBe('delegated');
    expect(result.specialistId).toBe('codex');
  });

  it('delegates to glm or gemini for SEMI_TRUSTED tier 2', () => {
    const registry = createRegistry(DEFAULT_SPECIALISTS.slice(1));
    const result = findSpecialist(
      registry,
      makeRequest({ requiredTrustLevel: SPECIALIST_TRUST_LEVELS.SEMI_TRUSTED, riskTier: 2 }),
    );
    expect(result.status).toBe('delegated');
    expect(['glm', 'gemini']).toContain(result.specialistId);
  });

  it('returns disabled for UNTRUSTED when grok is disabled and flag is on', () => {
    const registry = createRegistry(DEFAULT_SPECIALISTS);
    const flags = createFeatureFlags({ untrustedSpecialists: true });
    const result = findSpecialist(
      registry,
      makeRequest({ requiredTrustLevel: SPECIALIST_TRUST_LEVELS.UNTRUSTED, riskTier: 1 }),
      flags,
    );
    expect(result.status).toBe('disabled');
    expect(result.specialistId).toBe('grok');
  });

  it('returns no-match for UNTRUSTED when flag is off (default)', () => {
    const registry = createRegistry();
    const result = findSpecialist(
      registry,
      makeRequest({ requiredTrustLevel: SPECIALIST_TRUST_LEVELS.UNTRUSTED, riskTier: 1 }),
    );
    expect(result.status).toBe('no-match');
  });

  it('returns no-match for UNTRUSTED tier 3 even with flag on', () => {
    const registry = createRegistry();
    const flags = createFeatureFlags({ untrustedSpecialists: true });
    const result = findSpecialist(
      registry,
      makeRequest({ requiredTrustLevel: SPECIALIST_TRUST_LEVELS.UNTRUSTED, riskTier: 3 }),
      flags,
    );
    expect(result.status).toBe('no-match');
  });

  it('freezes defaults, registry, and result', () => {
    const registry = createRegistry();
    const result = findSpecialist(registry, makeRequest());
    expect(Object.isFrozen(DEFAULT_SPECIALISTS)).toBe(true);
    expect(Object.isFrozen(DEFAULT_SPECIALISTS[0])).toBe(true);
    expect(Object.isFrozen(registry)).toBe(true);
    expect(Object.isFrozen(registry.specialists)).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
  });
});
