/**
 * Cron Handler - スケジュールタスク管理
 *
 * 定期実行タスクの作成・取得・更新・削除を管理
 */

import { Env } from '../types';

export type TaskType = 'reminder' | 'report' | 'cleanup' | 'custom';

export interface ScheduledTask {
  id: string;
  user_id: string;
  cron_expression: string;
  task_type: TaskType;
  task_content: string;
  enabled: boolean;
  last_run_at?: string;
  next_run_at?: string;
  created_at?: string;
}

export interface CreateTaskInput {
  user_id: string;
  cron_expression: string;
  task_type: TaskType;
  task_content: string;
  enabled?: boolean;
}

export interface UpdateTaskInput {
  cron_expression?: string;
  task_type?: TaskType;
  task_content?: string;
  enabled?: boolean;
}

/**
 * Generate unique task ID
 */
function generateTaskId(): string {
  return `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Parse cron expression and calculate next run time
 * Supports basic patterns:
 * - `* * * * *` (every minute)
 * - `0 * * * *` (every hour)
 * - `0 9 * * *` (daily at 9am)
 * - `0 9 * * 1` (every Monday at 9am)
 *
 * Format: minute hour day-of-month month day-of-week
 */
export function calculateNextRun(cronExpression: string, fromDate?: Date): Date {
  const now = fromDate || new Date();
  const parts = cronExpression.trim().split(/\s+/);

  if (parts.length !== 5) {
    throw new Error(`Invalid cron expression: ${cronExpression}`);
  }

  const [minutePart, hourPart, dayPart, monthPart, dowPart] = parts;

  // Parse cron field value
  const parseField = (field: string, min: number, max: number): number[] => {
    if (field === '*') {
      return Array.from({ length: max - min + 1 }, (_, i) => min + i);
    }
    if (field.includes('/')) {
      const [, step] = field.split('/');
      const stepNum = parseInt(step, 10);
      return Array.from({ length: Math.floor((max - min + 1) / stepNum) + 1 }, (_, i) => min + i * stepNum)
        .filter(v => v <= max);
    }
    if (field.includes(',')) {
      return field.split(',').map(v => parseInt(v, 10));
    }
    if (field.includes('-')) {
      const [start, end] = field.split('-').map(v => parseInt(v, 10));
      return Array.from({ length: end - start + 1 }, (_, i) => start + i);
    }
    return [parseInt(field, 10)];
  };

  const validMinutes = parseField(minutePart, 0, 59);
  const validHours = parseField(hourPart, 0, 23);
  const validDays = parseField(dayPart, 1, 31);
  const validMonths = parseField(monthPart, 1, 12);
  const validDows = parseField(dowPart, 0, 6); // 0 = Sunday

  // Start searching from next minute
  const candidate = new Date(now);
  candidate.setSeconds(0);
  candidate.setMilliseconds(0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  // Search up to 1 year ahead
  const maxIterations = 366 * 24 * 60;

  for (let i = 0; i < maxIterations; i++) {
    const month = candidate.getMonth() + 1;
    const day = candidate.getDate();
    const dow = candidate.getDay();
    const hour = candidate.getHours();
    const minute = candidate.getMinutes();

    // Check if current candidate matches all fields
    const monthMatch = validMonths.includes(month);
    const dayMatch = dayPart === '*' || validDays.includes(day);
    const dowMatch = dowPart === '*' || validDows.includes(dow);
    const hourMatch = validHours.includes(hour);
    const minuteMatch = validMinutes.includes(minute);

    // Day-of-week and day-of-month: if both specified, either can match (OR logic)
    // If only one is specified (other is *), that one must match
    const dayOrDowMatch = (dayPart === '*' && dowMatch) ||
                          (dowPart === '*' && dayMatch) ||
                          (dayPart !== '*' && dowPart !== '*' && (dayMatch || dowMatch)) ||
                          (dayPart === '*' && dowPart === '*');

    if (monthMatch && dayOrDowMatch && hourMatch && minuteMatch) {
      return candidate;
    }

    // Advance by 1 minute
    candidate.setMinutes(candidate.getMinutes() + 1);
  }

  // Fallback: return 1 year from now
  const fallback = new Date(now);
  fallback.setFullYear(fallback.getFullYear() + 1);
  return fallback;
}

/**
 * Format date to ISO string for SQLite
 */
function formatDateForDb(date: Date): string {
  return date.toISOString().replace('T', ' ').replace('Z', '');
}

/**
 * Create a new scheduled task
 */
export async function createScheduledTask(
  env: Env,
  task: CreateTaskInput
): Promise<ScheduledTask> {
  if (!env.DB) {
    throw new Error('Database not available');
  }

  const id = generateTaskId();
  const nextRunAt = calculateNextRun(task.cron_expression);
  const enabled = task.enabled ?? true;

  await env.DB.prepare(`
    INSERT INTO scheduled_tasks (id, user_id, cron_expression, task_type, task_content, enabled, next_run_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).bind(
    id,
    task.user_id,
    task.cron_expression,
    task.task_type,
    task.task_content,
    enabled ? 1 : 0,
    formatDateForDb(nextRunAt)
  ).run();

  return {
    id,
    user_id: task.user_id,
    cron_expression: task.cron_expression,
    task_type: task.task_type,
    task_content: task.task_content,
    enabled,
    next_run_at: formatDateForDb(nextRunAt),
  };
}

/**
 * Get all scheduled tasks for a user
 */
export async function getScheduledTasks(
  env: Env,
  userId: string
): Promise<ScheduledTask[]> {
  if (!env.DB) return [];

  const result = await env.DB.prepare(`
    SELECT id, user_id, cron_expression, task_type, task_content, enabled, last_run_at, next_run_at, created_at
    FROM scheduled_tasks
    WHERE user_id = ?
    ORDER BY created_at DESC
  `).bind(userId).all();

  return (result.results || []).map((row: Record<string, unknown>) => ({
    id: row.id as string,
    user_id: row.user_id as string,
    cron_expression: row.cron_expression as string,
    task_type: row.task_type as TaskType,
    task_content: row.task_content as string,
    enabled: (row.enabled as number) === 1,
    last_run_at: row.last_run_at as string | undefined,
    next_run_at: row.next_run_at as string | undefined,
    created_at: row.created_at as string | undefined,
  }));
}

/**
 * Get a single task by ID
 */
export async function getTaskById(
  env: Env,
  taskId: string
): Promise<ScheduledTask | null> {
  if (!env.DB) return null;

  const result = await env.DB.prepare(`
    SELECT id, user_id, cron_expression, task_type, task_content, enabled, last_run_at, next_run_at, created_at
    FROM scheduled_tasks
    WHERE id = ?
  `).bind(taskId).first();

  if (!result) return null;

  return {
    id: result.id as string,
    user_id: result.user_id as string,
    cron_expression: result.cron_expression as string,
    task_type: result.task_type as TaskType,
    task_content: result.task_content as string,
    enabled: (result.enabled as number) === 1,
    last_run_at: result.last_run_at as string | undefined,
    next_run_at: result.next_run_at as string | undefined,
    created_at: result.created_at as string | undefined,
  };
}

/**
 * Update a scheduled task
 */
export async function updateScheduledTask(
  env: Env,
  taskId: string,
  updates: UpdateTaskInput
): Promise<ScheduledTask | null> {
  if (!env.DB) return null;

  // Get current task
  const currentTask = await getTaskById(env, taskId);
  if (!currentTask) return null;

  // Build update query dynamically
  const setClauses: string[] = [];
  const values: (string | number)[] = [];

  if (updates.cron_expression !== undefined) {
    setClauses.push('cron_expression = ?');
    values.push(updates.cron_expression);

    // Recalculate next_run_at when cron expression changes
    const nextRunAt = calculateNextRun(updates.cron_expression);
    setClauses.push('next_run_at = ?');
    values.push(formatDateForDb(nextRunAt));
  }

  if (updates.task_type !== undefined) {
    setClauses.push('task_type = ?');
    values.push(updates.task_type);
  }

  if (updates.task_content !== undefined) {
    setClauses.push('task_content = ?');
    values.push(updates.task_content);
  }

  if (updates.enabled !== undefined) {
    setClauses.push('enabled = ?');
    values.push(updates.enabled ? 1 : 0);
  }

  if (setClauses.length === 0) {
    return currentTask;
  }

  values.push(taskId);

  await env.DB.prepare(`
    UPDATE scheduled_tasks
    SET ${setClauses.join(', ')}
    WHERE id = ?
  `).bind(...values).run();

  return getTaskById(env, taskId);
}

/**
 * Delete a scheduled task
 */
export async function deleteScheduledTask(
  env: Env,
  taskId: string
): Promise<boolean> {
  if (!env.DB) return false;

  const result = await env.DB.prepare(`
    DELETE FROM scheduled_tasks
    WHERE id = ?
  `).bind(taskId).run();

  return (result.meta?.changes || 0) > 0;
}

/**
 * Get all tasks due for execution (next_run_at <= now and enabled)
 */
export async function getDueTasks(env: Env): Promise<ScheduledTask[]> {
  if (!env.DB) return [];

  const result = await env.DB.prepare(`
    SELECT id, user_id, cron_expression, task_type, task_content, enabled, last_run_at, next_run_at, created_at
    FROM scheduled_tasks
    WHERE enabled = 1
      AND next_run_at <= datetime('now')
    ORDER BY next_run_at ASC
  `).all();

  return (result.results || []).map((row: Record<string, unknown>) => ({
    id: row.id as string,
    user_id: row.user_id as string,
    cron_expression: row.cron_expression as string,
    task_type: row.task_type as TaskType,
    task_content: row.task_content as string,
    enabled: (row.enabled as number) === 1,
    last_run_at: row.last_run_at as string | undefined,
    next_run_at: row.next_run_at as string | undefined,
    created_at: row.created_at as string | undefined,
  }));
}

/**
 * Mark a task as executed and calculate next run time
 */
export async function markTaskExecuted(
  env: Env,
  taskId: string
): Promise<ScheduledTask | null> {
  if (!env.DB) return null;

  const task = await getTaskById(env, taskId);
  if (!task) return null;

  const now = new Date();
  const nextRunAt = calculateNextRun(task.cron_expression, now);

  await env.DB.prepare(`
    UPDATE scheduled_tasks
    SET last_run_at = datetime('now'),
        next_run_at = ?
    WHERE id = ?
  `).bind(formatDateForDb(nextRunAt), taskId).run();

  return getTaskById(env, taskId);
}

/**
 * Get tasks by type
 */
export async function getTasksByType(
  env: Env,
  taskType: TaskType
): Promise<ScheduledTask[]> {
  if (!env.DB) return [];

  const result = await env.DB.prepare(`
    SELECT id, user_id, cron_expression, task_type, task_content, enabled, last_run_at, next_run_at, created_at
    FROM scheduled_tasks
    WHERE task_type = ?
    ORDER BY created_at DESC
  `).bind(taskType).all();

  return (result.results || []).map((row: Record<string, unknown>) => ({
    id: row.id as string,
    user_id: row.user_id as string,
    cron_expression: row.cron_expression as string,
    task_type: row.task_type as TaskType,
    task_content: row.task_content as string,
    enabled: (row.enabled as number) === 1,
    last_run_at: row.last_run_at as string | undefined,
    next_run_at: row.next_run_at as string | undefined,
    created_at: row.created_at as string | undefined,
  }));
}

/**
 * Toggle task enabled status
 */
export async function toggleTaskEnabled(
  env: Env,
  taskId: string
): Promise<ScheduledTask | null> {
  if (!env.DB) return null;

  const task = await getTaskById(env, taskId);
  if (!task) return null;

  return updateScheduledTask(env, taskId, { enabled: !task.enabled });
}

export default {
  createScheduledTask,
  getScheduledTasks,
  getTaskById,
  updateScheduledTask,
  deleteScheduledTask,
  getDueTasks,
  markTaskExecuted,
  getTasksByType,
  toggleTaskEnabled,
  calculateNextRun,
};
