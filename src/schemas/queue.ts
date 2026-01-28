/**
 * Zod validation schemas for Queue API
 */

import { z } from 'zod';

/**
 * Zod schema for task claim request validation
 *
 * @remarks
 * Validates task claim requests with optional worker ID and lease duration (1-600s).
 */
export const ClaimTaskSchema = z.object({
  workerId: z.string().optional(),
  leaseDurationSec: z.number().int().min(1).max(600).optional(),
});

export type ClaimTaskInput = z.infer<typeof ClaimTaskSchema>;

/**
 * Zod schema for task lease release validation
 *
 * @remarks
 * Validates task release requests with optional worker ID and release reason.
 */
export const ReleaseTaskSchema = z.object({
  workerId: z.string().optional(),
  reason: z.string().optional(),
});

export type ReleaseTaskInput = z.infer<typeof ReleaseTaskSchema>;

/**
 * Zod schema for task lease renewal validation
 *
 * @remarks
 * Validates lease renewal requests with worker ID and optional extension duration (1-600s).
 */
export const RenewTaskSchema = z.object({
  workerId: z.string().min(1, 'Worker ID is required'),
  extendSec: z.number().int().min(1).max(600).optional(),
});

export type RenewTaskInput = z.infer<typeof RenewTaskSchema>;

/**
 * Zod schema for task status update validation
 *
 * @remarks
 * Validates task status update requests with required status field.
 */
export const UpdateStatusSchema = z.object({
  status: z.string().min(1, 'Status is required'),
});

export type UpdateStatusInput = z.infer<typeof UpdateStatusSchema>;

/**
 * Zod schema for task lease data validation
 *
 * @remarks
 * Validates lease data structure including worker ID, claim nonce,
 * and lease timing information.
 */
export const LeaseSchema = z.object({
  workerId: z.string(),
  claimNonce: z.string(),
  claimedAt: z.string(),
  expiresAt: z.string(),
});

export type LeaseData = z.infer<typeof LeaseSchema>;

/**
 * Zod schema for task result validation
 *
 * @remarks
 * Validates task execution results including success status,
 * optional output data, and error messages.
 */
export const ResultSchema = z.object({
  success: z.boolean(),
  output: z.unknown().optional(),
  error: z.string().optional(),
});

export type ResultInput = z.infer<typeof ResultSchema>;
