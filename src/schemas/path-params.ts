/**
 * Zod schemas for URL path parameter validation
 * 
 * SECURITY: Path parameters extracted via regex must be validated
 * to prevent injection attacks and ensure data integrity.
 */

import { z } from 'zod';

/**
 * User ID path parameter
 * Format: alphanumeric, hyphens, underscores
 * Length: 1-64 characters
 * 
 * Examples: "user-123", "U01ABC123", "user_abc_123"
 */
export const UserIdPathSchema = z.string()
  .min(1, 'User ID cannot be empty')
  .max(64, 'User ID too long')
  .regex(/^[a-zA-Z0-9_-]+$/, 'User ID must contain only alphanumeric characters, hyphens, and underscores');

/**
 * Task ID path parameter
 * Format: alphanumeric, hyphens
 * Length: 1-64 characters
 * 
 * Examples: "task-123", "abc-def-456"
 */
export const TaskIdPathSchema = z.string()
  .min(1, 'Task ID cannot be empty')
  .max(64, 'Task ID too long')
  .regex(/^[a-zA-Z0-9-]+$/, 'Task ID must contain only alphanumeric characters and hyphens');

/**
 * Channel path parameter (query string or path)
 * Format: lowercase alphanumeric, hyphens
 * Length: 1-32 characters
 * 
 * Examples: "slack", "discord", "line-bot"
 */
export const ChannelPathSchema = z.string()
  .min(1, 'Channel cannot be empty')
  .max(32, 'Channel name too long')
  .regex(/^[a-z0-9-]+$/, 'Channel must contain only lowercase alphanumeric characters and hyphens');

/**
 * Generic ID path parameter (most permissive)
 * Format: alphanumeric, hyphens, underscores
 * Length: 1-64 characters
 */
export const GenericIdPathSchema = z.string()
  .min(1, 'ID cannot be empty')
  .max(64, 'ID too long')
  .regex(/^[a-zA-Z0-9_-]+$/, 'ID must contain only alphanumeric characters, hyphens, and underscores');
