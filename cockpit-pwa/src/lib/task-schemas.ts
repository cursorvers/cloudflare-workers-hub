import { z } from 'zod';

/**
 * Zod Schemas for Task Validation
 *
 * Runtime validation for Server Actions input.
 */

export const taskStatusSchema = z.enum(['todo', 'in_progress', 'done', 'blocked']);
export const taskPrioritySchema = z.enum(['low', 'medium', 'high', 'urgent']);

export const createTaskSchema = z.object({
  title: z.string().min(1, 'Title is required').max(200, 'Title too long'),
  description: z.string().max(1000, 'Description too long').optional(),
  status: taskStatusSchema.optional(),
  priority: taskPrioritySchema.optional(),
  assignee: z.string().max(100, 'Assignee name too long').optional(),
});

export const updateTaskSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(1000).optional(),
  status: taskStatusSchema.optional(),
  priority: taskPrioritySchema.optional(),
  assignee: z.string().max(100).optional(),
});

export const taskIdSchema = z.number().int().positive();
export const taskIdsSchema = z.array(taskIdSchema).min(1, 'At least one task ID required');

export type CreateTaskInput = z.infer<typeof createTaskSchema>;
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;
