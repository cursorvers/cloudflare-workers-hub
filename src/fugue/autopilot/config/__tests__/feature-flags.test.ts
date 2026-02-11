import { describe, expect, it } from 'vitest';

import {
  DEFAULT_FEATURE_FLAGS,
  createFeatureFlags,
  isFeatureEnabled,
} from '../feature-flags';

describe('config/feature-flags', () => {
  it('defaults are all false', () => {
    expect(DEFAULT_FEATURE_FLAGS.untrustedSpecialists).toBe(false);
    expect(DEFAULT_FEATURE_FLAGS.autoCapability).toBe(false);
    expect(DEFAULT_FEATURE_FLAGS.embeddingBasedThrashing).toBe(false);
    expect(DEFAULT_FEATURE_FLAGS.advancedAnomalyDetection).toBe(false);
  });

  it('createFeatureFlags applies overrides', () => {
    const flags = createFeatureFlags({ autoCapability: true });
    expect(flags.autoCapability).toBe(true);
    expect(flags.untrustedSpecialists).toBe(false);
  });

  it('isFeatureEnabled returns enabled state', () => {
    const flags = createFeatureFlags({ advancedAnomalyDetection: true });
    expect(isFeatureEnabled(flags, 'advancedAnomalyDetection')).toBe(true);
    expect(isFeatureEnabled(flags, 'autoCapability')).toBe(false);
  });

  it('all exported flag objects are frozen', () => {
    const flags = createFeatureFlags();
    expect(Object.isFrozen(DEFAULT_FEATURE_FLAGS)).toBe(true);
    expect(Object.isFrozen(flags)).toBe(true);
  });
});
