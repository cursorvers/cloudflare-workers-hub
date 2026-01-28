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
