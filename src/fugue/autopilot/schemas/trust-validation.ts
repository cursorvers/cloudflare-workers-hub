/**
 * Trust boundary validation schemas and utilities.
 * Provides input validation and taint wrapping for the 3-zone trust model.
 */

import { z } from 'zod';
import type { TaintedData, TaintLabel } from '../types/trust-boundary';
import { TRUST_ZONES } from '../types/trust-boundary';

export type ValidationResult<T> =
  | { readonly success: true; readonly data: T }
  | { readonly success: false; readonly error: string };

export const TrustedConfigSchema = z
  .string()
  .min(1, 'Config must not be empty')
  .max(10_000, 'Config exceeds maximum length');

export const UserIntentSchema = z
  .string()
  .min(1, 'Intent must not be empty')
  .max(5_000, 'Intent exceeds maximum length');

/**
 * Control characters to strip from untrusted input.
 * Newline and tab are intentionally allowed.
 */
const CONTROL_CHAR_REGEX = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

export const UntrustedInputSchema = z
  .string()
  .max(50_000, 'Input exceeds maximum length')
  .transform((val) => val.replace(CONTROL_CHAR_REGEX, ''));

/** Validates trusted configuration text. */
export function validateTrustedConfig(
  input: unknown,
): ValidationResult<string> {
  const parsed = TrustedConfigSchema.safeParse(input);
  return parsed.success
    ? { success: true, data: parsed.data }
    : { success: false, error: parsed.error.message };
}

/** Validates user intent text. */
export function validateUserIntent(
  input: unknown,
): ValidationResult<string> {
  const parsed = UserIntentSchema.safeParse(input);
  return parsed.success
    ? { success: true, data: parsed.data }
    : { success: false, error: parsed.error.message };
}

/** Sanitizes untrusted input text by stripping control characters. */
export function sanitizeUntrusted(
  input: unknown,
): ValidationResult<string> {
  const parsed = UntrustedInputSchema.safeParse(input);
  return parsed.success
    ? { success: true, data: parsed.data }
    : { success: false, error: parsed.error.message };
}

/**
 * Wraps data with a non-promotable taint label.
 * The resulting TaintedData can never be promoted to trusted.
 */
export function wrapAsTainted<T>(
  data: T,
  source: string,
  traceId: string,
): TaintedData<T> {
  const taint: TaintLabel = Object.freeze({
    source,
    zone: TRUST_ZONES.EXTERNAL_UNTRUSTED,
    timestamp: new Date().toISOString(),
    traceId,
  });

  return Object.freeze({
    data,
    taint,
    promotable: false as const,
  });
}
