'use client';

import { useState, useEffect, useTransition, useCallback } from 'react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

/**
 * D1-backed Kanban Board
 *
 * Phase 5: Migrated from Server Actions to API routes
 * Uses shadcn/ui components (cockpit-pwa exception: system monitoring dashboard)
 */

// Task type (matching D1 schema)
interface Task {
  id: number;
  title: string;
  description: string | null;
  status: 'todo' | 'in_progress' | 'done' | 'blocked';
  priority: 'low' | 'medium' | 'high' | 'urgent';
  assignee: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

type TaskStatus = 'todo' | 'in_progress' | 'done' | 'blocked';

interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

const statusConfig: Record<
  TaskStatus,
  {
    label: string;
    icon: string;
    badgeVariant: 'default' | 'secondary' | 'outline';
  }
> = {
  todo: { label: 'To Do', icon: '📋', badgeVariant: 'outline' },
  in_progress: { label: 'In Progress', icon: '🔄', badgeVariant: 'secondary' },
  done: { label: 'Done', icon: '✅', badgeVariant: 'default' },
  blocked: { label: 'Blocked', icon: '🚫', badgeVariant: 'outline' },
};

// API client functions
const API_BASE = '/api/d1/tasks';

async function fetchTasks(): Promise<ApiResponse<Task[]>> {
  const response = await fetch(API_BASE);
  return response.json();
}

async function updateTaskStatusApi(taskId: number, status: TaskStatus): Promise<ApiResponse<Task>> {
  const response = await fetch(`${API_BASE}/${taskId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });
  return response.json();
}

interface D1KanbanBoardProps {
  apiKey?: string;
}

export function D1KanbanBoard({ apiKey }: D1KanbanBoardProps) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [retryCount, setRetryCount] = useState(0);

  // Load tasks from D1 via API with retry logic
  const loadTasks = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);

      const result = await fetchTasks();

      if (!result.success) {
        setError(result.error || 'Unknown error');
        return;
      }

      setTasks(result.data || []);
      setRetryCount(0); // Reset retry count on success
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to load tasks';
      setError(errorMessage);

      // Auto-retry for transient errors (max 3 attempts)
      if (retryCount < 3 && isTransientError(err)) {
        setTimeout(() => {
          setRetryCount((prev) => prev + 1);
        }, Math.pow(2, retryCount) * 1000); // Exponential backoff
      }
    } finally {
      setIsLoading(false);
    }
  }, [retryCount]);

  useEffect(() => {
    loadTasks();
  }, [loadTasks, apiKey]);

  // Helper: Check if error is transient
  const isTransientError = (err: unknown): boolean => {
    if (!(err instanceof Error)) return false;
    const transientPatterns = ['timeout', 'network', 'SQLITE_BUSY', 'fetch'];
    return transientPatterns.some((p) =>
      err.message.toLowerCase().includes(p.toLowerCase())
    );
  };

  // Handle status change via API
  const handleStatusChange = async (taskId: number, newStatus: TaskStatus) => {
    startTransition(async () => {
      try {
        const result = await updateTaskStatusApi(taskId, newStatus);

        if (!result.success) {
          setError(result.error || 'Failed to update task');
          return;
        }

        if (result.data) {
          // Optimistic update
          setTasks((prev) =>
            prev.map((t) => (t.id === taskId ? result.data! : t))
          );
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to update task');
      }
    });
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-sm text-zinc-500 dark:text-zinc-400">
          Loading tasks...
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-4">
        <div className="text-sm text-red-500">{error}</div>
        {retryCount > 0 && (
          <div className="text-xs text-zinc-500">
            Retry attempt {retryCount}/3...
          </div>
        )}
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setRetryCount(0);
            loadTasks();
          }}
        >
          Retry
        </Button>
      </div>
    );
  }

  const columns: TaskStatus[] = ['todo', 'in_progress', 'done', 'blocked'];
  const tasksByStatus = columns.reduce(
    (acc, status) => {
      acc[status] = tasks.filter((t) => t.status === status);
      return acc;
    },
    {} as Record<TaskStatus, Task[]>
  );

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
          D1 Kanban Board
        </h2>
        <Badge variant="outline">
          {tasks.length} {tasks.length === 1 ? 'task' : 'tasks'}
        </Badge>
      </div>

      {/* Kanban Columns */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {columns.map((status) => (
          <KanbanColumn
            key={status}
            status={status}
            tasks={tasksByStatus[status]}
            onStatusChange={handleStatusChange}
            isPending={isPending}
          />
        ))}
      </div>
    </div>
  );
}

interface KanbanColumnProps {
  status: TaskStatus;
  tasks: Task[];
  onStatusChange: (taskId: number, newStatus: TaskStatus) => void;
  isPending: boolean;
}

function KanbanColumn({
  status,
  tasks,
  onStatusChange,
  isPending,
}: KanbanColumnProps) {
  const config = statusConfig[status];

  return (
    <div className="space-y-2">
      {/* Column Header */}
      <div className="flex items-center gap-2 px-3 py-2 bg-zinc-100 dark:bg-zinc-800 rounded-lg">
        <span aria-hidden="true">{config.icon}</span>
        <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
          {config.label}
        </span>
        <Badge variant={config.badgeVariant} className="ml-auto text-xs">
          {tasks.length}
        </Badge>
      </div>

      {/* Tasks */}
      <div className="space-y-2 min-h-[200px]">
        {tasks.length === 0 ? (
          <div className="flex items-center justify-center h-32 text-sm text-zinc-400 dark:text-zinc-600">
            No tasks
          </div>
        ) : (
          tasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              onStatusChange={onStatusChange}
              isPending={isPending}
            />
          ))
        )}
      </div>
    </div>
  );
}

interface TaskCardProps {
  task: Task;
  onStatusChange: (taskId: number, newStatus: TaskStatus) => void;
  isPending: boolean;
}

function TaskCard({ task, onStatusChange, isPending }: TaskCardProps) {
  const priorityColors: Record<string, string> = {
    low: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
    medium: 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300',
    high: 'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300',
    urgent: 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300',
  };

  return (
    <Card className="p-4 space-y-3 hover:shadow-md transition-shadow">
      {/* Title */}
      <h3 className="font-medium text-zinc-900 dark:text-zinc-100">
        {task.title}
      </h3>

      {/* Description */}
      {task.description && (
        <p className="text-sm text-zinc-600 dark:text-zinc-400 line-clamp-2">
          {task.description}
        </p>
      )}

      {/* Metadata */}
      <div className="flex items-center gap-2 flex-wrap">
        {task.priority && (
          <Badge
            variant="outline"
            className={priorityColors[task.priority] || ''}
          >
            {task.priority}
          </Badge>
        )}
        {task.assignee && (
          <span className="text-xs text-zinc-500 dark:text-zinc-400">
            @{task.assignee}
          </span>
        )}
      </div>

      {/* Status Change Buttons (Quick Actions) */}
      <div className="flex gap-2 flex-wrap">
        {(['todo', 'in_progress', 'done', 'blocked'] as TaskStatus[])
          .filter((s) => s !== task.status)
          .map((targetStatus) => (
            <Button
              key={targetStatus}
              size="sm"
              variant="outline"
              onClick={() => onStatusChange(task.id, targetStatus)}
              disabled={isPending}
              className="text-xs"
            >
              → {statusConfig[targetStatus].label}
            </Button>
          ))}
      </div>
    </Card>
  );
}
