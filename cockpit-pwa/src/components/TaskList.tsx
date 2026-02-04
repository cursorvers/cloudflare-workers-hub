'use client';

import { useState, useEffect } from 'react';
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
  // Auto-expand when there are tasks, collapse when empty
  const [isExpanded, setIsExpanded] = useState(tasks.length > 0);

  // Auto-expand when new tasks arrive
  useEffect(() => {
    if (tasks.length > 0) {
      setIsExpanded(true);
    }
  }, [tasks.length]);

  const pendingCount = tasks.filter((t) => t.status === 'pending').length;
  const runningCount = tasks.filter((t) => t.status === 'running').length;

  if (isLoading) {
    return (
      <div className="space-y-2">
        <button
          className="w-full text-sm font-semibold text-zinc-700 dark:text-zinc-300 px-1 flex items-center gap-2"
          disabled
        >
          <span className="animate-spin">⏳</span>
          <span>タスク一覧</span>
          <span className="text-xs text-zinc-400 ml-auto">読み込み中...</span>
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full text-sm font-semibold text-zinc-700 dark:text-zinc-300 px-1 flex items-center gap-2 hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors"
      >
        <span className={`transition-transform duration-200 ${isExpanded ? 'rotate-90' : ''}`}>
          ▶
        </span>
        <span>タスク一覧</span>
        {tasks.length === 0 ? (
          <Badge variant="outline" className="text-xs">
            なし
          </Badge>
        ) : (
          <>
            {runningCount > 0 && (
              <Badge variant="secondary" className="text-xs">
                {runningCount} 実行中
              </Badge>
            )}
            {pendingCount > 0 && (
              <Badge variant="outline" className="text-xs">
                {pendingCount} 待機
              </Badge>
            )}
          </>
        )}
        <span className="text-xs text-zinc-400 ml-auto">
          {tasks.length} tasks
        </span>
      </button>

      {isExpanded && (
        <div className="animate-fade-in">
          {tasks.length === 0 ? (
            <div className="bg-white dark:bg-zinc-900 rounded-xl p-4 text-center border border-zinc-200 dark:border-zinc-800">
              <p className="text-zinc-500 dark:text-zinc-400 text-sm">
                チャットで指示を送信するとタスクが作成されます
              </p>
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
        animate-fade-in
        card-hover
        ${onTap ? 'cursor-pointer tap-scale active:bg-zinc-50 dark:active:bg-zinc-800 transition-colors' : ''}
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
