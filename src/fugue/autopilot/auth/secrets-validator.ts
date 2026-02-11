export interface SecretValidationResult {
  readonly valid: boolean;
  readonly missing: readonly string[];
  readonly empty: readonly string[];
  readonly reason: string;
}

export const REQUIRED_SECRETS = Object.freeze([
  'AUTOPILOT_API_KEY',
  'AUTOPILOT_WEBHOOK_SECRET',
] as const);

function freezeValidationResult(
  result: SecretValidationResult,
): SecretValidationResult {
  return Object.freeze({
    ...result,
    missing: Object.freeze([...result.missing]),
    empty: Object.freeze([...result.empty]),
  });
}

// Reject undefined/null/empty/whitespace-only values.
export function validateSecretValue(
  value: string | undefined | null,
): boolean {
  if (typeof value !== 'string') return false;
  return value.trim().length > 0;
}

// Fail-closed: any missing/empty required secret marks configuration invalid.
export function validateRequiredSecrets(
  secrets: Readonly<Record<string, string | undefined>>,
  requiredKeys: readonly string[] = REQUIRED_SECRETS,
): SecretValidationResult {
  const missing: string[] = [];
  const empty: string[] = [];

  for (const key of requiredKeys) {
    const value = secrets[key];
    if (value === undefined) {
      missing.push(key);
      continue;
    }
    if (!validateSecretValue(value)) {
      empty.push(key);
    }
  }

  if (missing.length === 0 && empty.length === 0) {
    return freezeValidationResult({
      valid: true,
      missing: [],
      empty: [],
      reason: 'all required secrets are present and non-empty',
    });
  }

  const reasons: string[] = [];
  if (missing.length > 0) {
    reasons.push(`missing: ${missing.join(', ')}`);
  }
  if (empty.length > 0) {
    reasons.push(`empty_or_whitespace: ${empty.join(', ')}`);
  }

  return freezeValidationResult({
    valid: false,
    missing,
    empty,
    reason: `required secret validation failed (${reasons.join('; ')})`,
  });
}

// Log-safe secret representation: keep first 2 chars only.
export function maskSecret(value: string): string {
  return `${value.slice(0, 2)}****`;
}
