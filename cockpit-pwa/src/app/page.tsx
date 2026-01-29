'use client';

import { useState, useCallback, useEffect } from 'react';
import { useWebSocket, type WebSocketMessage } from '@/hooks/useWebSocket';
import { ConnectionStatus } from '@/components/ConnectionStatus';
import { TaskList, type Task } from '@/components/TaskList';
import { AlertsList, type Alert } from '@/components/AlertsList';
import { GitRepoList, type GitRepo } from '@/components/GitRepoList';
import { ProviderHealth, type ProviderStatus } from '@/components/ProviderHealth';
import { CommandInput } from '@/components/CommandInput';

// WebSocket URL with API key fallback for authentication
const WS_BASE = process.env.NEXT_PUBLIC_WS_URL || 'wss://orchestrator-hub.masa-stage1.workers.dev/api/ws';
const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'https://orchestrator-hub.masa-stage1.workers.dev/api';
const API_KEY = process.env.NEXT_PUBLIC_API_KEY;

// Build WebSocket URL with optional token parameter for fallback auth
const WS_URL = API_KEY ? `${WS_BASE}?token=${API_KEY}` : WS_BASE;

/**
 * FUGUE Cockpit - Multi-Agent Orchestration Dashboard
 * Features:
 * - Real-time task monitoring
 * - Alert notifications
 * - Git repository status
 * - Provider health monitoring
 * - Command input for orchestrator
 */
export default function Dashboard() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [repos, setRepos] = useState<GitRepo[]>([]);
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // Fetch initial data via REST API
  const fetchInitialData = useCallback(async () => {
    const headers: HeadersInit = {
      'Content-Type': 'application/json',
    };
    if (API_KEY) {
      headers['Authorization'] = `Bearer ${API_KEY}`;
    }

    try {
      // Fetch tasks, repos, and alerts in parallel
      const [tasksRes, reposRes, alertsRes] = await Promise.all([
        fetch(`${API_BASE}/cockpit/tasks?limit=20`, { headers }),
        fetch(`${API_BASE}/cockpit/repos?limit=10`, { headers }),
        fetch(`${API_BASE}/cockpit/alerts?acknowledged=false&limit=10`, { headers }),
      ]);

      if (tasksRes.ok) {
        const data = await tasksRes.json();
        setTasks(data.tasks || []);
      }

      if (reposRes.ok) {
        const data = await reposRes.json();
        setRepos(data.repos || []);
      }

      if (alertsRes.ok) {
        const data = await alertsRes.json();
        setAlerts(data.alerts || []);
      }
    } catch (error) {
      console.error('[Dashboard] Failed to fetch initial data:', error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Handle WebSocket messages
  const handleMessage = useCallback((message: WebSocketMessage) => {
    console.log('[Dashboard] Received:', message);

    switch (message.type) {
      // Task messages
      case 'tasks':
        if (Array.isArray(message.payload)) {
          setTasks(message.payload as Task[]);
        }
        break;
      case 'task_update':
      case 'task-result':
        if (message.payload) {
          const updatedTask = message.payload as Task;
          setTasks((prev) =>
            prev.map((t) => (t.id === updatedTask.id ? { ...t, ...updatedTask } : t))
          );
        }
        break;
      case 'task_created':
      case 'task':
        if (message.payload) {
          const newTask = message.payload as Task;
          setTasks((prev) => {
            // Avoid duplicates
            if (prev.some((t) => t.id === newTask.id)) {
              return prev.map((t) => (t.id === newTask.id ? newTask : t));
            }
            return [newTask, ...prev];
          });
        }
        break;

      // Git status messages
      case 'git-status':
        if (message.payload && Array.isArray((message.payload as any).repos)) {
          setRepos((message.payload as any).repos);
        }
        break;

      // Alert messages
      case 'alert':
        if (message.payload) {
          const newAlert = message.payload as Alert;
          setAlerts((prev) => {
            if (prev.some((a) => a.id === newAlert.id)) {
              return prev;
            }
            return [newAlert, ...prev].slice(0, 20);
          });
        }
        break;

      // Provider health messages
      case 'observability-sync':
        if (message.payload) {
          const data = message.payload as any;
          if (data.provider_health) {
            setProviders(data.provider_health);
          }
        }
        break;

      // Acknowledgment
      case 'ack':
        console.log('[Dashboard] Command acknowledged');
        break;

      default:
        console.log('[Dashboard] Unknown message type:', message.type);
    }
  }, []);

  const { state, send, reconnect } = useWebSocket({
    url: WS_URL,
    onMessage: handleMessage,
    onOpen: () => {
      console.log('[Dashboard] WebSocket connected');
      // Request initial status
      send({ type: 'status-request' });
    },
    onClose: () => {
      console.log('[Dashboard] WebSocket disconnected');
    },
  });

  // Fetch initial data on mount
  useEffect(() => {
    fetchInitialData();
  }, [fetchInitialData]);

  // Handle command input
  const handleCommand = useCallback(
    (command: string) => {
      console.log('[Dashboard] Sending command:', command);

      // Parse command
      if (command.startsWith('/')) {
        const [cmd, ...args] = command.slice(1).split(' ');

        switch (cmd) {
          case 'status':
            send({ type: 'status-request' });
            break;
          case 'tasks':
            fetchInitialData();
            break;
          case 'git':
            // Request git status
            send({ type: 'status-request' });
            break;
          case 'help':
            // Show help (could be a toast/modal)
            console.log('Available commands: /status, /tasks, /git, /help');
            break;
          default:
            // Send as generic command
            send({ type: 'command', payload: { command: cmd, args } });
        }
      } else {
        // Send as chat message (for future AI interaction)
        send({ type: 'chat', payload: { message: command } });
      }
    },
    [send, fetchInitialData]
  );

  // Handle alert acknowledgment
  const handleAcknowledgeAlert = useCallback(
    async (alertId: string) => {
      const headers: HeadersInit = {
        'Content-Type': 'application/json',
      };
      if (API_KEY) {
        headers['Authorization'] = `Bearer ${API_KEY}`;
      }

      try {
        const res = await fetch(`${API_BASE}/cockpit/alerts/ack/${alertId}`, {
          method: 'POST',
          headers,
        });

        if (res.ok) {
          setAlerts((prev) =>
            prev.map((a) => (a.id === alertId ? { ...a, acknowledged: true } : a))
          );
        }
      } catch (error) {
        console.error('[Dashboard] Failed to acknowledge alert:', error);
      }
    },
    []
  );

  const isConnected = state === 'connected';

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

      {/* Main content - Scrollable */}
      <main className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {/* Alerts - Priority display */}
        <AlertsList
          alerts={alerts}
          onAcknowledge={handleAcknowledgeAlert}
          maxVisible={3}
        />

        {/* Tasks */}
        <TaskList
          tasks={tasks}
          isLoading={isLoading && !isConnected}
          onTaskTap={(task) => {
            console.log('[Dashboard] Task tapped:', task);
          }}
        />

        {/* Git Repositories */}
        <GitRepoList
          repos={repos}
          onRepoTap={(repo) => {
            console.log('[Dashboard] Repo tapped:', repo);
          }}
        />

        {/* Provider Health */}
        <ProviderHealth providers={providers} />
      </main>

      {/* Command Input - Fixed bottom */}
      <CommandInput
        onSend={handleCommand}
        disabled={!isConnected}
        placeholder={isConnected ? 'コマンドを入力...' : '接続中...'}
      />
    </div>
  );
}
