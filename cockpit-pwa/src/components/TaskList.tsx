'use client';

import { Badge } from '@/components/ui/badge';

// Task type (read-only for Phase 3)
export interface Task {
  id: string;
  title: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  executor?: string;
  createdAt?: string;
}

interface TaskListProps {
  tasks: Task[];
  isLoading?: boolean;
  onTaskTap?: (task: Task) => void;
}

const statusConfig: Record<Task['status'], {
  label: string;
  variant: 'default' | 'secondary' | 'destructive' | 'outline';
  icon: string;
}> = {
  pending: { label: '待機中', variant: 'outline', icon: '⏳' },
  running: { label: '実行中', variant: 'secondary', icon: '🔄' },
  completed: { label: '完了', variant: 'default', icon: '✅' },
  failed: { label: '失敗', variant: 'destructive', icon: '❌' },
};

/**
 * Mobile-optimized task list with card UI
 * Gemini UI/UX Review: タップ領域 44px 以上確保、カード型 UI
 */
export function TaskList({ tasks, isLoading, onTaskTap }: TaskListProps) {
  if (isLoading) {
    return (
      <div className="space-y-3">
        <h2 className="text-sm font-medium text-zinc-600 dark:text-zinc-400 px-1">
          タスク一覧
        </h2>
        {/* Skeleton loading - 3 items */}
        {[1, 2, 3].map((i) => (
          <div
            key={i}
            className="bg-white dark:bg-zinc-900 rounded-xl p-4 animate-pulse"
          >
            <div className="h-4 bg-zinc-200 dark:bg-zinc-700 rounded w-3/4 mb-2" />
            <div className="h-3 bg-zinc-100 dark:bg-zinc-800 rounded w-1/2" />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <h2 className="text-sm font-medium text-zinc-600 dark:text-zinc-400 px-1">
        タスク一覧 ({tasks.length})
      </h2>

      {tasks.length === 0 ? (
        <div className="bg-white dark:bg-zinc-900 rounded-xl p-6 text-center">
          <p className="text-zinc-500 text-sm">タスクがありません</p>
        </div>
      ) : (
        <ul className="space-y-2">
          {tasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              onTap={onTaskTap ? () => onTaskTap(task) : undefined}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

interface TaskCardProps {
  task: Task;
  onTap?: () => void;
}

/**
 * Individual task card with touch-friendly design
 * Touch target: min 44px height (actually 56px+ with padding)
 */
function TaskCard({ task, onTap }: TaskCardProps) {
  const config = statusConfig[task.status];

  return (
    <li
      role={onTap ? 'button' : undefined}
      tabIndex={onTap ? 0 : undefined}
      onClick={onTap}
      onKeyDown={(e) => {
        if (onTap && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          onTap();
        }
      }}
      className={`
        bg-white dark:bg-zinc-900
        rounded-xl
        border border-zinc-200 dark:border-zinc-800
        p-4
        min-h-[56px]
        flex items-center gap-3
        ${onTap ? 'cursor-pointer active:bg-zinc-50 dark:active:bg-zinc-800 transition-colors' : ''}
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500
      `}
    >
      {/* Status icon - visual indicator */}
      <span className="text-lg flex-shrink-0" aria-hidden="true">
        {config.icon}
      </span>

      {/* Task info */}
      <div className="flex-1 min-w-0">
        <p className="font-medium text-zinc-900 dark:text-zinc-100 truncate">
          {task.title}
        </p>
        {task.executor && (
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
            {task.executor}
          </p>
        )}
      </div>

      {/* Status badge */}
      <Badge variant={config.variant} className="flex-shrink-0">
        {config.label}
      </Badge>
    </li>
  );
}
