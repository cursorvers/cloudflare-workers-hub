/**
 * Zod validation schemas for Slack webhooks
 */

import { z } from 'zod';

/**
 * Zod schema for Slack event message validation
 *
 * @remarks
 * Validates individual Slack event messages within webhook payloads.
 * Supports message text, user, channel, timestamps, and bot identification.
 */
export const SlackEventMessageSchema = z.object({
  type: z.string(),
  text: z.string().optional(),
  user: z.string().optional(),
  channel: z.string().optional(),
  ts: z.string().optional(),
  thread_ts: z.string().optional(),
  bot_id: z.string().optional(),
});

/**
 * Zod schema for Slack webhook payload validation
 *
 * @remarks
 * Validates complete Slack webhook payloads including URL verification
 * challenges and event callbacks. Handles both challenge responses and
 * event notifications.
 */
export const SlackWebhookSchema = z.object({
  token: z.string().optional(),
  challenge: z.string().optional(),
  type: z.string(),
  event: SlackEventMessageSchema.optional(),
  team_id: z.string().optional(),
  api_app_id: z.string().optional(),
});

export type SlackWebhookInput = z.infer<typeof SlackWebhookSchema>;
