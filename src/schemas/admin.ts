/**
 * Zod validation schemas for Admin API
 */

import { z } from 'zod';

/**
 * Schema for API key mapping creation
 */
export const CreateAPIKeyMappingSchema = z.object({
  apiKey: z.string().min(1, 'API key is required'),
  userId: z.string().min(1, 'User ID is required'),
  role: z.enum(['service', 'user']).optional().default('user'),
});

export type CreateAPIKeyMappingInput = z.infer<typeof CreateAPIKeyMappingSchema>;

/**
 * Schema for API key mapping deletion
 */
export const DeleteAPIKeyMappingSchema = z.object({
  apiKey: z.string().min(1, 'API key is required'),
});

export type DeleteAPIKeyMappingInput = z.infer<typeof DeleteAPIKeyMappingSchema>;

/**
 * Schema for queue KV -> D1 migration
 */
export const MigrateQueueKVToD1Schema = z.object({
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(500).optional().default(200),
  cleanup: z.boolean().optional().default(false),
});

export type MigrateQueueKVToD1Input = z.infer<typeof MigrateQueueKVToD1Schema>;

/**
 * Schema for result KV -> D1 migration
 */
export const MigrateResultsKVToD1Schema = z.object({
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(500).optional().default(200),
  cleanup: z.boolean().optional().default(false),
});

export type MigrateResultsKVToD1Input = z.infer<typeof MigrateResultsKVToD1Schema>;
