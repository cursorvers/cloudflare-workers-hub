/**
 * User Reflections Schema (Phase 5)
 * Purpose: Type-safe validation for collaborative reflection system
 */

import { z } from 'zod';

// ============================================================================
// Database Models
// ============================================================================

/**
 * Reflection workflow status for lifelog_highlights
 */
export const ReflectionStatusSchema = z.enum([
  'pending_review',
  'under_review',
  'completed',
  'archived',
]);

export type ReflectionStatus = z.infer<typeof ReflectionStatusSchema>;

/**
 * User reflection record (from database)
 */
export const UserReflectionSchema = z.object({
  id: z.string().uuid(),
  highlight_id: z.string().uuid(),
  user_id: z.string(),
  reflection_text: z.string().min(1),
  key_insights: z.array(z.string()).default([]),
  action_items: z.array(z.string()).default([]),
  contains_phi: z.boolean().default(false),
  phi_approved: z.boolean().default(false),
  is_public: z.boolean().default(false),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});

export type UserReflection = z.infer<typeof UserReflectionSchema>;

/**
 * Extended lifelog_highlight with reflection workflow fields
 */
export const LifelogHighlightWithReflectionSchema = z.object({
  id: z.string().uuid(),
  lifelog_id: z.string().uuid(),
  limitless_id: z.string(),
  highlight_time: z.string().datetime(),
  start_time: z.string().datetime(),
  end_time: z.string().datetime(),
  extracted_text: z.string().nullable(),
  speaker_name: z.string().nullable(),
  topics: z.array(z.string()).default([]),
  processing_status: z.enum(['pending', 'processing', 'completed', 'failed']),
  error_message: z.string().nullable(),
  retry_count: z.number().int().default(0),
  trigger_source: z.string().default('ios_shortcut'),
  processed_at: z.string().datetime().nullable(),
  user_reflection: z.string().nullable(),
  user_action_plan: z.string().nullable(),
  // Phase 5 additions
  status: ReflectionStatusSchema.default('pending_review'),
  notified_at: z.string().datetime().nullable(),
  reviewed_at: z.string().datetime().nullable(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});

export type LifelogHighlightWithReflection = z.infer<typeof LifelogHighlightWithReflectionSchema>;

// ============================================================================
// API Request/Response Models
// ============================================================================

/**
 * Request: Create new reflection
 */
export const CreateReflectionRequestSchema = z.object({
  highlight_id: z.string().uuid(),
  reflection_text: z.string().min(10).max(5000),
  key_insights: z.array(z.string().min(1).max(500)).max(10).optional(),
  action_items: z.array(z.string().min(1).max(500)).max(10).optional(),
  is_public: z.boolean().default(false),
});

export type CreateReflectionRequest = z.infer<typeof CreateReflectionRequestSchema>;

/**
 * Request: Update existing reflection
 */
export const UpdateReflectionRequestSchema = z.object({
  reflection_text: z.string().min(10).max(5000).optional(),
  key_insights: z.array(z.string().min(1).max(500)).max(10).optional(),
  action_items: z.array(z.string().min(1).max(500)).max(10).optional(),
  is_public: z.boolean().optional(),
  phi_approved: z.boolean().optional(), // Only if contains_phi is true
});

export type UpdateReflectionRequest = z.infer<typeof UpdateReflectionRequestSchema>;

/**
 * Response: Reflection with related highlight
 */
export const ReflectionWithHighlightSchema = UserReflectionSchema.extend({
  highlight: LifelogHighlightWithReflectionSchema.optional(),
});

export type ReflectionWithHighlight = z.infer<typeof ReflectionWithHighlightSchema>;

/**
 * Request: Get pending reviews
 */
export const GetPendingReviewsRequestSchema = z.object({
  limit: z.number().int().positive().max(100).default(20),
  offset: z.number().int().nonnegative().default(0),
  status: ReflectionStatusSchema.optional(),
  notified_only: z.boolean().default(false), // Only highlights that have been notified
});

export type GetPendingReviewsRequest = z.infer<typeof GetPendingReviewsRequestSchema>;

/**
 * Response: List of pending reviews
 */
export const PendingReviewsResponseSchema = z.object({
  highlights: z.array(LifelogHighlightWithReflectionSchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
});

export type PendingReviewsResponse = z.infer<typeof PendingReviewsResponseSchema>;

// ============================================================================
// PHI Detection Models
// ============================================================================

/**
 * PHI detection result
 */
export const PHIDetectionResultSchema = z.object({
  contains_phi: z.boolean(),
  detected_patterns: z.array(
    z.object({
      type: z.enum(['name', 'date_of_birth', 'mrn', 'phone', 'email', 'address']),
      value: z.string(),
      confidence: z.number().min(0).max(1),
    })
  ),
  masked_text: z.string(),
  confidence_score: z.number().min(0).max(100),
  needs_verification: z.boolean(),
});

export type PHIDetectionResult = z.infer<typeof PHIDetectionResultSchema>;

// ============================================================================
// Notification Models
// ============================================================================

/**
 * Notification payload for Discord/Slack
 */
export const ReflectionNotificationSchema = z.object({
  highlight_id: z.string().uuid(),
  highlight_time: z.string().datetime(),
  extracted_text: z.string().nullable(),
  speaker_name: z.string().nullable(),
  topics: z.array(z.string()),
  notification_url: z.string().url(), // URL to review in PWA
});

export type ReflectionNotification = z.infer<typeof ReflectionNotificationSchema>;

/**
 * Request: Send notification
 */
export const SendNotificationRequestSchema = z.object({
  highlight_id: z.string().uuid(),
  channel: z.enum(['discord', 'slack', 'pwa']),
  force: z.boolean().default(false), // Ignore frequency control
});

export type SendNotificationRequest = z.infer<typeof SendNotificationRequestSchema>;

// ============================================================================
// Validation Helpers
// ============================================================================

// ============================================================================
// Metrics Models
// ============================================================================

/**
 * Supported metrics periods
 */
export const LimitlessMetricsPeriodSchema = z.enum(['7d', '30d', '90d']);

export type LimitlessMetricsPeriod = z.infer<typeof LimitlessMetricsPeriodSchema>;

/**
 * Metrics API response
 */
export const LimitlessMetricsResponseSchema = z.object({
  reflection_rate: z.object({
    total_highlights: z.number().int().nonnegative(),
    with_reflection: z.number().int().nonnegative(),
    percentage: z.number().min(0).max(100),
  }),
  phi_detection: z.object({
    total_scanned: z.number().int().nonnegative(),
    phi_detected: z.number().int().nonnegative(),
    false_positive_rate: z.number().min(0).max(100),
  }),
  response_time: z.object({
    avg_hours: z.number().nonnegative(),
    within_48h_percentage: z.number().min(0).max(100),
  }),
  period: z.object({
    start: z.string().datetime(),
    end: z.string().datetime(),
  }),
});

export type LimitlessMetricsResponse = z.infer<typeof LimitlessMetricsResponseSchema>;

/**
 * Validate reflection text for PHI patterns
 * Returns true if text likely contains PHI
 */
export function containsPotentialPHI(text: string): boolean {
  const phiPatterns = [
    /\b\d{3}-\d{2}-\d{4}\b/, // SSN
    /\b\d{10}\b/, // MRN (10 digits)
    /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/, // Phone
    /\b(19|20)\d{2}[-/](0[1-9]|1[0-2])[-/](0[1-9]|[12]\d|3[01])\b/, // Date of birth
  ];

  return phiPatterns.some((pattern) => pattern.test(text));
}

/**
 * Validate that PHI approval is consistent with public flag
 */
export function validatePHIConsistency(reflection: Partial<UserReflection>): boolean {
  if (!reflection.contains_phi) {
    return true; // No PHI, no constraints
  }

  if (reflection.is_public && !reflection.phi_approved) {
    return false; // Cannot make PHI content public without approval
  }

  return true;
}
