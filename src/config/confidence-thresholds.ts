/**
 * Confidence Thresholds (Centralized)
 *
 * All confidence/sensitivity thresholds for the receipt→freee pipeline.
 * Design: Two-threshold system (Create vs Auto-confirm).
 *
 * Rationale (3-party consensus 2026-02-09):
 * - User requires HIGH SENSITIVITY (false positives OK, manual correction easy in freee)
 * - minCreateConfidence: low → create deals broadly as needs_review
 * - minAutoConfidence: moderate → only auto-confirm when confident
 * - Separate thresholds prevent garbage auto-confirmation while maximizing coverage
 */

// =============================================================================
// Pipeline Thresholds
// =============================================================================

export const CONFIDENCE = {
  /** Minimum confidence to CREATE a deal (status=needs_review). Very low to maximize coverage. */
  MIN_CREATE: 0.25,

  /** Minimum confidence to AUTO-CONFIRM a deal (status=created). Moderate. */
  MIN_AUTO: 0.50,

  /** Minimum confidence for auto-confirm when amount ≥ HIGH_AMOUNT_JPY. Conservative. */
  MIN_AUTO_HIGH_AMOUNT: 0.70,

  /** Cap applied when quality issues detected (email vendor, zero amount). Raised from 0.3→0.6. */
  QUALITY_ISSUE_CAP: 0.6,

  /** Workers AI → OpenAI escalation threshold. Lowered from 0.85→0.65. */
  WORKERS_ESCALATE: 0.65,

  /** Top-2 candidate score gap below which selection is considered ambiguous. */
  SCORE_GAP_AMBIGUOUS: 0.06,

  /** Minimum confidence for auto-confirm when candidates are ambiguous. */
  MIN_AUTO_AMBIGUOUS: 0.55,
} as const;

// =============================================================================
// Amount Thresholds
// =============================================================================

export const AMOUNT = {
  /** High-risk amount (JPY). Above this, prefer higher-quality model or stricter review. */
  HIGH_AMOUNT_JPY: 500_000,
} as const;

// =============================================================================
// Rate Limits
// =============================================================================

export const RATE_LIMITS = {
  /** Max deals to create per cron run (freee 300 req/hr budget). */
  MAX_DEALS_PER_RUN: 8,

  /** Max Gmail messages to fetch per poll. */
  MAX_RESULTS: 15,

  /** Max HTML emails to fetch per poll. */
  MAX_HTML_RESULTS: 10,
} as const;

// =============================================================================
// Health / Alerting
// =============================================================================

export const HEALTH = {
  /** Hours without successful poll before alerting. */
  ALERT_NO_POLL_HOURS: 6,

  /** KV key for last successful poll timestamp. */
  LAST_POLL_KEY: 'receipt:last_successful_poll',
} as const;

// =============================================================================
// Helpers
// =============================================================================

/**
 * Determine deal status based on confidence.
 * Two-threshold: below MIN_CREATE → no deal, MIN_CREATE..MIN_AUTO → needs_review, above → created.
 */
export function decideDealStatus(
  confidence: number,
  amount: number,
  scoreGap: number
): 'skip' | 'needs_review' | 'created' {
  if (confidence < CONFIDENCE.MIN_CREATE) {
    return 'skip';
  }

  const autoThreshold =
    amount >= AMOUNT.HIGH_AMOUNT_JPY
      ? CONFIDENCE.MIN_AUTO_HIGH_AMOUNT
      : scoreGap < CONFIDENCE.SCORE_GAP_AMBIGUOUS
        ? CONFIDENCE.MIN_AUTO_AMBIGUOUS
        : CONFIDENCE.MIN_AUTO;

  return confidence >= autoThreshold ? 'created' : 'needs_review';
}
