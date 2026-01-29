'use client';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

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
}

const statusConfig: Record<Task['status'], { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }> = {
  pending: { label: '待機中', variant: 'outline' },
  running: { label: '実行中', variant: 'secondary' },
  completed: { label: '完了', variant: 'default' },
  failed: { label: '失敗', variant: 'destructive' },
};

export function TaskList({ tasks, isLoading }: TaskListProps) {
  if (isLoading) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">タスク一覧</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-zinc-500">読み込み中...</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">
          タスク一覧 ({tasks.length})
        </CardTitle>
      </CardHeader>
      <CardContent>
        {tasks.length === 0 ? (
          <p className="text-sm text-zinc-500">タスクなし</p>
        ) : (
          <ul className="space-y-2">
            {tasks.map((task) => {
              const config = statusConfig[task.status];
              return (
                <li
                  key={task.id}
                  className="flex items-center justify-between p-2 bg-zinc-50 dark:bg-zinc-800 rounded"
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{task.title}</p>
                    {task.executor && (
                      <p className="text-xs text-zinc-500">{task.executor}</p>
                    )}
                  </div>
                  <Badge variant={config.variant}>{config.label}</Badge>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
