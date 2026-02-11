/**
 * Trust boundary type definitions for FUGUE Autopilot.
 * Defines trust zones, taint labels, and typed prompt slots.
 */
export const TRUST_ZONES = Object.freeze({
  TRUSTED_CONFIG: 'TRUSTED_CONFIG',
  USER_INTENT: 'USER_INTENT',
  EXTERNAL_UNTRUSTED: 'EXTERNAL_UNTRUSTED',
} as const);

export type TrustZone = (typeof TRUST_ZONES)[keyof typeof TRUST_ZONES];

/**
 * Metadata describing where a piece of data came from and how it should be handled.
 */
export interface TaintLabel {
  readonly source: string;
  readonly zone: TrustZone;
  readonly timestamp: string;
  readonly traceId: string;
}

/**
 * Data wrapped with a taint label.
 * `promotable` is always false for tainted data and must never be overridden.
 *
 * NOTE: Object.freeze is shallow. When T is an object/array, inner properties
 * remain mutable. For security-critical paths, use TaintedData<string> (primitive)
 * or apply structuredClone before wrapping to avoid shared references.
 */
export interface TaintedData<T> {
  readonly data: T;
  readonly taint: TaintLabel;
  readonly promotable: false;
}

export const PROMPT_SLOTS = Object.freeze({
  POLICY_CONTEXT: 'POLICY_CONTEXT',
  TRUSTED_INPUT: 'TRUSTED_INPUT',
  UNTRUSTED_DATA: 'UNTRUSTED_DATA',
} as const);

export type PromptSlot = (typeof PROMPT_SLOTS)[keyof typeof PROMPT_SLOTS];

/**
 * Typed prompt slots to avoid accidental mixing of trusted and untrusted data.
 */
export interface TypedPromptSlots {
  readonly policy: string;
  readonly trusted: string;
  readonly untrusted: TaintedData<string>;
}
