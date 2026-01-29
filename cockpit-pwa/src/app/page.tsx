'use client';

import { useState, useCallback } from 'react';
import { useWebSocket, type WebSocketMessage } from '@/hooks/useWebSocket';
import { ConnectionStatus } from '@/components/ConnectionStatus';
import { TaskList, type Task } from '@/components/TaskList';

// WebSocket URL with API key fallback for authentication
const WS_BASE = process.env.NEXT_PUBLIC_WS_URL || 'wss://orchestrator-hub.masa-stage1.workers.dev/api/ws';
const API_KEY = process.env.NEXT_PUBLIC_API_KEY;

// Build WebSocket URL with optional token parameter for fallback auth
const WS_URL = API_KEY ? `${WS_BASE}?token=${API_KEY}` : WS_BASE;

/**
 * FUGUE Cockpit - Mobile-First Dashboard
 * Gemini UI/UX Review 対応:
 * - ConnectionStatus をヘッダーに統合（省スペース）
 * - タスクリストをメインコンテンツに（画面領域最大化）
 * - 親指操作エリア（Thumb Zone）考慮
 */
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

  const { state, reconnect } = useWebSocket({
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
    <div className="min-h-screen min-h-[100dvh] bg-zinc-100 dark:bg-zinc-950 flex flex-col">
      {/* Header - Fixed, compact */}
      <header className="sticky top-0 z-10 bg-white dark:bg-zinc-900 border-b border-zinc-200 dark:border-zinc-800 px-4 py-3 safe-area-inset-top">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-bold text-zinc-900 dark:text-zinc-100">
              FUGUE Cockpit
            </h1>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Multi-Agent Orchestration
            </p>
          </div>
          {/* Connection status - compact indicator */}
          <ConnectionStatus state={state} onReconnect={reconnect} />
        </div>
      </header>

      {/* Main content - Scrollable, full width */}
      <main className="flex-1 overflow-y-auto px-4 py-4 pb-safe">
        <TaskList
          tasks={tasks}
          isLoading={isLoading && state === 'connected'}
          onTaskTap={(task) => {
            // Future: Open task detail modal
            console.log('[Dashboard] Task tapped:', task);
          }}
        />
      </main>

      {/* Bottom safe area padding for iOS */}
      <div className="h-safe-bottom bg-zinc-100 dark:bg-zinc-950" />
    </div>
  );
}
