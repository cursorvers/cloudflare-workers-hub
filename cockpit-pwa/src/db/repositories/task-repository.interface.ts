import type { Task, NewTask } from '../schema';

/**
 * Task Repository Interface
 *
 * Interface-First approach: Define contract before implementation
 * to enable easy migration between phases.
 */
export interface ITaskRepository {
  // Read operations
  findAll(): Promise<Task[]>;
  findById(id: number): Promise<Task | undefined>;
  findByStatus(status: Task['status']): Promise<Task[]>;

  // Write operations
  create(task: NewTask): Promise<Task>;
  update(id: number, task: Partial<NewTask>): Promise<Task | undefined>;
  delete(id: number): Promise<boolean>;

  // Batch operations
  updateStatus(id: number, status: Task['status']): Promise<Task | undefined>;
  bulkUpdateStatus(ids: number[], status: Task['status']): Promise<number>;
}
