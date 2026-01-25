/**
 * Zod validation schemas for Queue API
 */

import { z } from 'zod';

/**
 * Schema for claiming a task
 */
export const ClaimTaskSchema = z.object({
  workerId: z.string().optional(),
  leaseDurationSec: z.number().int().min(1).max(600).optional(),
});

export type ClaimTaskInput = z.infer<typeof ClaimTaskSchema>;

/**
 * Schema for releasing a task lease
 */
export const ReleaseTaskSchema = z.object({
  workerId: z.string().optional(),
  reason: z.string().optional(),
});

export type ReleaseTaskInput = z.infer<typeof ReleaseTaskSchema>;

/**
 * Schema for renewing a task lease
 */
export const RenewTaskSchema = z.object({
  workerId: z.string().min(1, 'Worker ID is required'),
  extendSec: z.number().int().min(1).max(600).optional(),
});

export type RenewTaskInput = z.infer<typeof RenewTaskSchema>;

/**
 * Schema for updating task status
 */
export const UpdateStatusSchema = z.object({
  status: z.string().min(1, 'Status is required'),
});

export type UpdateStatusInput = z.infer<typeof UpdateStatusSchema>;

/**
 * Schema for lease data validation
 */
export const LeaseSchema = z.object({
  workerId: z.string(),
  claimNonce: z.string(),
  claimedAt: z.string(),
  expiresAt: z.string(),
});

export type LeaseData = z.infer<typeof LeaseSchema>;

/**
 * Schema for task result
 */
export const ResultSchema = z.object({
  success: z.boolean(),
  output: z.unknown().optional(),
  error: z.string().optional(),
});

export type ResultInput = z.infer<typeof ResultSchema>;
