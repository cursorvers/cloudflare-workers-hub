/**
 * Zod schemas for autopilot.yml (FUGUE Autopilot v1.1).
 *
 * Validates and normalizes untrusted YAML-derived inputs.
 * All fields have defaults for v1.0 backwards compatibility.
 * Unknown properties are stripped (not rejected).
 */

import { z } from 'zod';

/** Result of parsing a possibly-untrusted autopilot.yml input. */
export type ParseResult<T> =
  | { readonly success: true; readonly data: T }
  | { readonly success: false; readonly error: string };

export const MetaSchema = z
  .object({
    project: z.string().default('unnamed'),
    mode: z.enum(['autopilot', 'collaborative']).default('collaborative'),
    created_by: z.string().default('unknown'),
    engaged_at: z.string().nullable().default(null),
  })
  .strip();

export const GovernanceSchema = z
  .object({
    vote_quorum: z.number().int().min(1).max(5).default(2),
    claude_checkpoints: z.boolean().default(true),
    gemini_ui_review: z.boolean().default(true),
    grok_realtime: z.boolean().default(true),
    escalation_after: z.number().int().min(1).default(3),
    risk_tiers: z
      .object({
        tier_0: z.array(z.string()).default(['read', 'lint', 'test']),
        tier_1: z.array(z.string()).default(['single_file_edit']),
        tier_2: z.array(z.string()).default(['multi_file', 'design']),
        tier_3: z.array(z.string()).default(['delete', 'deploy', 'auth']),
        tier_4: z.array(z.string()).default(['production', 'irreversible']),
      })
      .default({}),
  })
  .strip();

export const PscsrSchema = z
  .object({
    default: z.enum(['auto', 'required', 'skip']).default('auto'),
    rounds: z.number().int().min(1).max(5).default(3),
  })
  .strip();

export const SafetySchema = z
  .object({
    max_retry_per_task: z.number().int().min(0).default(3),
    max_token_budget_per_task: z.number().int().min(0).default(50_000),
    max_consecutive_failures: z.number().int().min(1).default(2),
    circuit_breaker: z.boolean().default(true),
    idle_timeout_hours: z.number().min(0).default(72),
    thrashing_detection: z
      .object({
        max_fix_cycles: z.number().int().min(1).default(3),
        similarity_threshold: z.number().min(0).max(1).default(0.92),
      })
      .default({}),
  })
  .strip();

export const TaskSchema = z
  .object({
    id: z.string().min(1),
    description: z.string().min(1),
    acceptance_criteria: z.array(z.string()).default([]),
    priority: z.enum(['low', 'medium', 'high', 'critical']).default('medium'),
    dependencies: z.array(z.string()).default([]),
    delegate_to: z.string().default('codex'),
    pscsr: z.enum(['required', 'auto', 'skip']).default('auto'),
    risk_tier: z.number().int().min(0).max(4).default(1),
  })
  .strip();

export const NotificationsSchema = z
  .object({
    on_complete: z.array(z.string()).default(['github_issue']),
    on_escalation: z.array(z.string()).default(['discord']),
    on_milestone: z.array(z.string()).default(['github_issue']),
  })
  .strip();

export const AutopilotYmlSchema = z
  .object({
    meta: MetaSchema.default({}),
    governance: GovernanceSchema.default({}),
    pscsr: PscsrSchema.default({}),
    safety: SafetySchema.default({}),
    tasks: z.array(TaskSchema).default([]),
    notifications: NotificationsSchema.default({}),
  })
  .strip();

export type AutopilotYml = z.infer<typeof AutopilotYmlSchema>;

/**
 * Parse and validate an autopilot.yml input.
 * Uses safeParse; on error, returns a human-readable error string.
 */
export function parseAutopilotYml(
  input: unknown,
): ParseResult<AutopilotYml> {
  const parsed = AutopilotYmlSchema.safeParse(input);
  if (parsed.success) {
    return { success: true, data: parsed.data };
  }
  const issues = parsed.error.issues.map(
    (i) => `${i.path.join('.')}: ${i.message}`,
  );
  return { success: false, error: issues.join('; ') };
}
