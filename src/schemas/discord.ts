/**
 * Zod validation schemas for Discord webhooks
 */

import { z } from 'zod';

/**
 * Schema for Discord interaction data
 */
const DiscordInteractionDataSchema = z.object({
  id: z.string(),
  name: z.string(),
  options: z.array(z.object({
    name: z.string(),
    type: z.number(),
    value: z.string(),
  })).optional(),
});

/**
 * Schema for Discord user
 */
const DiscordUserSchema = z.object({
  id: z.string(),
  username: z.string(),
});

/**
 * Schema for Discord member
 */
const DiscordMemberSchema = z.object({
  user: DiscordUserSchema,
});

/**
 * Schema for Discord message
 */
const DiscordMessageSchema = z.object({
  id: z.string(),
  content: z.string(),
});

/**
 * Schema for Discord webhook payload
 */
export const DiscordWebhookSchema = z.object({
  type: z.number().int().min(1).max(5),
  id: z.string(),
  application_id: z.string(),
  token: z.string(),
  data: DiscordInteractionDataSchema.optional(),
  guild_id: z.string().optional(),
  channel_id: z.string().optional(),
  member: DiscordMemberSchema.optional(),
  message: DiscordMessageSchema.optional(),
});

export type DiscordWebhookInput = z.infer<typeof DiscordWebhookSchema>;
