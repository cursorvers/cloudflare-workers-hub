'use server';

import { getRequestContext } from '@cloudflare/next-on-pages';
import { headers } from 'next/headers';
import { TaskRepository } from '@/db/repositories/task-repository';
import type { Task } from '@/db/schema';
import { revalidatePath } from 'next/cache';
import { wrapAction, type ActionResult } from '@/lib/action-result';
import { requireAuth, requirePermission } from '@/lib/action-auth';
import { logAudit, createAuditContext } from '@/lib/audit-logger';
import {
  createTaskSchema,
  updateTaskSchema,
  taskIdSchema,
  taskIdsSchema,
  taskStatusSchema,
  type CreateTaskInput,
  type UpdateTaskInput,
} from '@/lib/task-schemas';

/**
 * Server Actions for Task Management
 *
 * Implements GLM conditions:
 * 1. Zod validation for all inputs
 * 2. Authentication check with requireAuth()
 * 3. Result pattern for unified error handling
 */

function getTaskRepository() {
  const { env } = getRequestContext();
  if (!env.DB) {
    throw new Error('D1 Database binding not found');
  }
  return new TaskRepository(env.DB);
}

export async function getTasks(): Promise<ActionResult<Task[]>> {
  return wrapAction(async () => {
    await requireAuth();
    const repo = getTaskRepository();
    return repo.findAll();
  });
}

export async function getTaskById(
  id: number
): Promise<ActionResult<Task | undefined>> {
  return wrapAction(async () => {
    await requireAuth();
    const validId = taskIdSchema.parse(id);
    const repo = getTaskRepository();
    return repo.findById(validId);
  });
}

export async function getTasksByStatus(
  status: Task['status']
): Promise<ActionResult<Task[]>> {
  return wrapAction(async () => {
    await requireAuth();
    const validStatus = taskStatusSchema.parse(status);
    const repo = getTaskRepository();
    return repo.findByStatus(validStatus);
  });
}

export async function createTask(
  input: CreateTaskInput
): Promise<ActionResult<Task>> {
  return wrapAction(async () => {
    const auth = await requirePermission('create', 'task');
    const validInput = createTaskSchema.parse(input);
    const repo = getTaskRepository();
    const newTask = await repo.create(validInput);

    // Audit log
    const { env } = getRequestContext();
    const headersList = await headers();
    await logAudit(
      env.DB,
      createAuditContext(auth.userId || 'unknown', headersList),
      'create',
      'task',
      newTask.id.toString(),
      { title: newTask.title, status: newTask.status }
    );

    revalidatePath('/');
    return newTask;
  });
}

export async function updateTask(
  id: number,
  input: UpdateTaskInput
): Promise<ActionResult<Task | undefined>> {
  return wrapAction(async () => {
    const auth = await requirePermission('update', 'task');
    const validId = taskIdSchema.parse(id);
    const validInput = updateTaskSchema.parse(input);
    const repo = getTaskRepository();
    const updated = await repo.update(validId, validInput);

    // Audit log
    if (updated) {
      const { env } = getRequestContext();
      const headersList = await headers();
      await logAudit(
        env.DB,
        createAuditContext(auth.userId || 'unknown', headersList),
        'update',
        'task',
        updated.id.toString(),
        validInput
      );
    }

    revalidatePath('/');
    return updated;
  });
}

export async function deleteTask(id: number): Promise<ActionResult<boolean>> {
  return wrapAction(async () => {
    const auth = await requirePermission('delete', 'task');
    const validId = taskIdSchema.parse(id);
    const repo = getTaskRepository();
    const deleted = await repo.delete(validId);

    // Audit log
    if (deleted) {
      const { env } = getRequestContext();
      const headersList = await headers();
      await logAudit(
        env.DB,
        createAuditContext(auth.userId || 'unknown', headersList),
        'delete',
        'task',
        validId.toString()
      );
    }

    revalidatePath('/');
    return deleted;
  });
}

export async function updateTaskStatus(
  id: number,
  status: Task['status']
): Promise<ActionResult<Task | undefined>> {
  return wrapAction(async () => {
    const auth = await requirePermission('update', 'task');
    const validId = taskIdSchema.parse(id);
    const validStatus = taskStatusSchema.parse(status);
    const repo = getTaskRepository();
    const updated = await repo.updateStatus(validId, validStatus);

    // Audit log
    if (updated) {
      const { env } = getRequestContext();
      const headersList = await headers();
      await logAudit(
        env.DB,
        createAuditContext(auth.userId || 'unknown', headersList),
        'status_change',
        'task',
        updated.id.toString(),
        { status: validStatus }
      );
    }

    revalidatePath('/');
    return updated;
  });
}

export async function bulkUpdateTaskStatus(
  ids: number[],
  status: Task['status']
): Promise<ActionResult<number>> {
  return wrapAction(async () => {
    await requireAuth();
    const validIds = taskIdsSchema.parse(ids);
    const validStatus = taskStatusSchema.parse(status);
    const repo = getTaskRepository();
    const count = await repo.bulkUpdateStatus(validIds, validStatus);
    revalidatePath('/');
    return count;
  });
}
