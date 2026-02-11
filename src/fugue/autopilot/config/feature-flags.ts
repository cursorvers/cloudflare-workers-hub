export interface FeatureFlags {
  readonly untrustedSpecialists: boolean;
  readonly autoCapability: boolean;
  readonly embeddingBasedThrashing: boolean;
  readonly advancedAnomalyDetection: boolean;
}

export const DEFAULT_FEATURE_FLAGS: FeatureFlags = Object.freeze({
  untrustedSpecialists: false,
  autoCapability: false,
  embeddingBasedThrashing: false,
  advancedAnomalyDetection: false,
});

export function createFeatureFlags(
  overrides: Partial<FeatureFlags> = {},
): FeatureFlags {
  return Object.freeze({ ...DEFAULT_FEATURE_FLAGS, ...overrides });
}

export function isFeatureEnabled(
  flags: FeatureFlags,
  feature: keyof FeatureFlags,
): boolean {
  return flags[feature];
}
