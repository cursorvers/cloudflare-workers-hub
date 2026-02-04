import { drizzle } from 'drizzle-orm/d1';
import { eq, inArray } from 'drizzle-orm';
import type { D1Database } from '@cloudflare/workers-types';
import { cockpitTasks } from '../schema';
import type { Task, NewTask } from '../schema';
import type { ITaskRepository } from './task-repository.interface';

/**
 * Task Repository Implementation (Drizzle ORM)
 *
 * Implements ITaskRepository interface with D1-backed storage.
 */
export class TaskRepository implements ITaskRepository {
  private db;

  constructor(d1: D1Database) {
    this.db = drizzle(d1);
  }

  async findAll(): Promise<Task[]> {
    return this.db.select().from(cockpitTasks).all();
  }

  async findById(id: number): Promise<Task | undefined> {
    const results = await this.db
      .select()
      .from(cockpitTasks)
      .where(eq(cockpitTasks.id, id))
      .limit(1)
      .all();
    return results[0];
  }

  async findByStatus(status: Task['status']): Promise<Task[]> {
    return this.db
      .select()
      .from(cockpitTasks)
      .where(eq(cockpitTasks.status, status))
      .all();
  }

  async create(task: NewTask): Promise<Task> {
    const results = await this.db
      .insert(cockpitTasks)
      .values(task)
      .returning()
      .all();
    return results[0];
  }

  async update(id: number, task: Partial<NewTask>): Promise<Task | undefined> {
    const results = await this.db
      .update(cockpitTasks)
      .set({ ...task, updatedAt: new Date() })
      .where(eq(cockpitTasks.id, id))
      .returning()
      .all();
    return results[0];
  }

  async delete(id: number): Promise<boolean> {
    const result = await this.db
      .delete(cockpitTasks)
      .where(eq(cockpitTasks.id, id))
      .run();
    return result.success;
  }

  async updateStatus(
    id: number,
    status: Task['status']
  ): Promise<Task | undefined> {
    return this.update(id, { status });
  }

  async bulkUpdateStatus(
    ids: number[],
    status: Task['status']
  ): Promise<number> {
    const result = await this.db
      .update(cockpitTasks)
      .set({ status, updatedAt: new Date() })
      .where(inArray(cockpitTasks.id, ids))
      .run();
    return result.meta.changes;
  }
}
