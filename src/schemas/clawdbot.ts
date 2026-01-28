/**
 * Zod validation schemas for ClawdBot webhooks
 */

import { z } from 'zod';

/**
 * Schema for ClawdBot user
 */
const ClawdBotUserSchema = z.object({
  id: z.string().min(1, 'User ID is required'),
  name: z.string().optional(),
  phone: z.string().optional(),
});

/**
 * Schema for ClawdBot message payload
 */
export const ClawdBotMessageSchema = z.object({
  id: z.string().min(1, 'Message ID is required'),
  channel: z.enum(['whatsapp', 'telegram', 'web', 'unknown']),
  user: ClawdBotUserSchema,
  message: z.string().min(1, 'Message content is required'),
  timestamp: z.string().min(1, 'Timestamp is required'),
  metadata: z.record(z.unknown()).optional(),
  replyTo: z.string().optional(),
});

export type ClawdBotMessageInput = z.infer<typeof ClawdBotMessageSchema>;
