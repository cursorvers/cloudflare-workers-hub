/**
 * Zod validation schemas for Memory API
 */

import { z } from 'zod';

/**
 * Schema for saving a conversation message
 */
export const ConversationMessageSchema = z.object({
  id: z.string().optional(),
  user_id: z.string().min(1, 'User ID is required'),
  channel: z.string().min(1, 'Channel is required'),
  source: z.string().optional(),
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string().min(1, 'Content is required'),
  metadata: z.record(z.unknown()).optional(),
  created_at: z.string().datetime().optional(),
});

export type ConversationMessageInput = z.infer<typeof ConversationMessageSchema>;

/**
 * Schema for user preferences
 */
export const UserPreferencesSchema = z.object({
  user_id: z.string().min(1, 'User ID is required'),
  display_name: z.string().optional(),
  timezone: z.string().min(1, 'Timezone is required'),
  language: z.string().min(1, 'Language is required'),
  preferences: z.record(z.unknown()).optional(),
});

export type UserPreferencesInput = z.infer<typeof UserPreferencesSchema>;
