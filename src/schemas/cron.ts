/**
 * Zod validation schemas for Cron API
 */

import { z } from 'zod';

/**
 * Valid task types
 */
const TaskTypeSchema = z.enum(['reminder', 'report', 'cleanup', 'custom']);

/**
 * Cron expression validation (basic format check)
 */
const CronExpressionSchema = z.string()
  .regex(/^(\*|([0-9]|1[0-9]|2[0-9]|3[0-9]|4[0-9]|5[0-9])|\*\/([0-9]+)|([0-9]+-[0-9]+)|([0-9]+(,[0-9]+)*)) (\*|([0-9]|1[0-9]|2[0-3])|\*\/([0-9]+)|([0-9]+-[0-9]+)|([0-9]+(,[0-9]+)*)) (\*|([1-9]|1[0-9]|2[0-9]|3[0-1])|\*\/([0-9]+)|([0-9]+-[0-9]+)|([0-9]+(,[0-9]+)*)) (\*|([1-9]|1[0-2])|\*\/([0-9]+)|([0-9]+-[0-9]+)|([0-9]+(,[0-9]+)*)) (\*|([0-6])|\*\/([0-9]+)|([0-9]+-[0-9]+)|([0-9]+(,[0-9]+)*))$/,
    'Invalid cron expression format');

/**
 * Schema for creating a scheduled task
 */
export const CreateTaskSchema = z.object({
  user_id: z.string().min(1, 'User ID is required'),
  cron_expression: CronExpressionSchema,
  task_type: TaskTypeSchema,
  task_content: z.string().min(1, 'Task content is required'),
  enabled: z.boolean().optional(),
});

export type CreateTaskInput = z.infer<typeof CreateTaskSchema>;

/**
 * Schema for updating a scheduled task
 */
export const UpdateTaskSchema = z.object({
  cron_expression: CronExpressionSchema.optional(),
  task_type: TaskTypeSchema.optional(),
  task_content: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
});

export type UpdateTaskInput = z.infer<typeof UpdateTaskSchema>;
