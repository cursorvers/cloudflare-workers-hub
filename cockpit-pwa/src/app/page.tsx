'use client';

import { useState, useCallback } from 'react';
import { useWebSocket, type WebSocketMessage } from '@/hooks/useWebSocket';
import { ConnectionStatus } from '@/components/ConnectionStatus';
import { TaskList, type Task } from '@/components/TaskList';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

const WS_URL = process.env.NEXT_PUBLIC_WS_URL || 'wss://orchestrator-hub.masa-stage1.workers.dev/ws/cockpit';

export default function Dashboard() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const handleMessage = useCallback((message: WebSocketMessage) => {
    console.log('[Dashboard] Received:', message);

    // Handle task-related messages
    if (message.type === 'tasks' && Array.isArray(message.payload)) {
      setTasks(message.payload as Task[]);
      setIsLoading(false);
    } else if (message.type === 'task_update' && message.payload) {
      const updatedTask = message.payload as Task;
      setTasks((prev) =>
        prev.map((t) => (t.id === updatedTask.id ? updatedTask : t))
      );
    } else if (message.type === 'task_created' && message.payload) {
      const newTask = message.payload as Task;
      setTasks((prev) => [newTask, ...prev]);
    }
  }, []);

  const { state, lastMessage, reconnect } = useWebSocket({
    url: WS_URL,
    onMessage: handleMessage,
    onOpen: () => {
      console.log('[Dashboard] WebSocket connected');
      setIsLoading(true);
    },
    onClose: () => {
      console.log('[Dashboard] WebSocket disconnected');
    },
  });

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950 p-4">
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">
          FUGUE Cockpit
        </h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Multi-Agent Orchestration Dashboard
        </p>
      </header>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {/* Connection Status */}
        <ConnectionStatus state={state} onReconnect={reconnect} />

        {/* Task List */}
        <TaskList tasks={tasks} isLoading={isLoading && state === 'connected'} />

        {/* Last Message (Debug) */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">最新メッセージ</CardTitle>
          </CardHeader>
          <CardContent>
            {lastMessage ? (
              <pre className="text-xs overflow-auto max-h-32 bg-zinc-100 dark:bg-zinc-800 p-2 rounded">
                {JSON.stringify(lastMessage, null, 2)}
              </pre>
            ) : (
              <p className="text-sm text-zinc-500">メッセージなし</p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
