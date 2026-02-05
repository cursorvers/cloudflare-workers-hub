'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { useWebSocket, type WebSocketMessage, type ConnectionState, type ReconnectState, type ErrorDetail } from '@/hooks/useWebSocket';
import { ConnectionStatus } from '@/components/ConnectionStatus';
import { TaskList, type Task } from '@/components/TaskList';
import { AlertsList, type Alert } from '@/components/AlertsList';
import { GitRepoList, type GitRepo } from '@/components/GitRepoList';
import { ProviderHealth, type ProviderStatus } from '@/components/ProviderHealth';
import { DaemonStatus } from '@/components/DaemonStatus';
import { CommandInput } from '@/components/CommandInput';
import { MessageLog, createLogEntry, type LogEntry } from '@/components/MessageLog';
import { PushSettings } from '@/components/PushSettings';
import { SystemMetrics } from '@/components/SystemMetrics';
import { ActivityFeed, type Activity } from '@/components/ActivityFeed';
import { QuickActions } from '@/components/QuickActions';
import { ApprovalQueue, type PendingCommand } from '@/components/ApprovalQueue';
// TODO: Re-enable after Server Actions migration to API routes
// import { D1KanbanBoard } from '@/components/D1KanbanBoard';
import type { HeartbeatInfo, RealtimeHeartbeatMap } from '@/types/heartbeat';

// WebSocket URL with API key fallback for authentication
const WS_BASE = process.env.NEXT_PUBLIC_WS_URL || 'wss://orchestrator-hub.masa-stage1.workers.dev/api/ws';
const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'https://orchestrator-hub.masa-stage1.workers.dev/api';
const API_KEY = process.env.NEXT_PUBLIC_API_KEY;

// Build WebSocket URL with optional token parameter for fallback auth
const WS_URL = API_KEY ? `${WS_BASE}?token=${API_KEY}` : WS_BASE;

// Debounce delay for connection state
const STATE_DEBOUNCE_MS = 500;

/**
 * Custom hook to debounce connection state changes
 * Prevents UI flickering during rapid reconnection cycles
 */
function useDebouncedConnectionState(state: ConnectionState): ConnectionState {
  const [displayState, setDisplayState] = useState<ConnectionState>(state);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }

    // Immediately show 'connected' state (good news should be instant)
    if (state === 'connected') {
      setDisplayState(state);
      return;
    }

    // Debounce other state changes to reduce flickering
    timerRef.current = setTimeout(() => {
      setDisplayState(state);
    }, STATE_DEBOUNCE_MS);

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, [state]);

  return displayState;
}

/**
 * FUGUE Cockpit - Multi-Agent Orchestration Dashboard
 * Enhanced with comprehensive feedback system
 */
export default function Dashboard() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [repos, setRepos] = useState<GitRepo[]>([]);
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [logEntries, setLogEntries] = useState<LogEntry[]>([]);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [realtimeHeartbeats, setRealtimeHeartbeats] = useState<RealtimeHeartbeatMap>(
    new Map<string, HeartbeatInfo>()
  );
  const [pendingCommands, setPendingCommands] = useState<PendingCommand[]>([]);

  // Track if initial connection toast has been shown
  const hasShownInitialToast = useRef(false);
  const reconnectToastId = useRef<string | number | undefined>(undefined);

  // Add log entry helper
  const addLogEntry = useCallback((type: LogEntry['type'], content: string, status?: LogEntry['status']) => {
    setLogEntries((prev) => [...prev.slice(-19), createLogEntry(type, content, status)]);
  }, []);

  // Add activity helper
  const addActivity = useCallback((
    type: Activity['type'],
    action: string,
    message: string,
    metadata?: Record<string, unknown>
  ) => {
    const activity: Activity = {
      id: `act_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      type,
      action,
      message,
      timestamp: Date.now(),
      metadata,
    };
    setActivities((prev) => [activity, ...prev].slice(0, 50));
  }, []);

  // Update log entry status
  const updateLogEntryStatus = useCallback((content: string, status: LogEntry['status']) => {
    setLogEntries((prev) =>
      prev.map((entry) =>
        entry.content === content && entry.status === 'pending'
          ? { ...entry, status }
          : entry
      )
    );
  }, []);

  // Clear log entries
  const clearLogEntries = useCallback(() => {
    setLogEntries([]);
  }, []);

  // Fetch initial data via REST API
  const fetchInitialData = useCallback(async () => {
    const headers: HeadersInit = {
      'Content-Type': 'application/json',
    };
    if (API_KEY) {
      headers['Authorization'] = `Bearer ${API_KEY}`;
    }

    try {
      const [tasksRes, reposRes, alertsRes] = await Promise.all([
        fetch(`${API_BASE}/cockpit/tasks?limit=20`, { headers }),
        fetch(`${API_BASE}/cockpit/repos?limit=10`, { headers }),
        fetch(`${API_BASE}/cockpit/alerts?acknowledged=false&limit=10`, { headers }),
      ]);

      const errors: string[] = [];

      if (tasksRes.ok) {
        const data = await tasksRes.json();
        setTasks(data.tasks || []);
      } else {
        errors.push('タスク');
      }

      if (reposRes.ok) {
        const data = await reposRes.json();
        setRepos(data.repos || []);
      } else {
        errors.push('リポジトリ');
      }

      if (alertsRes.ok) {
        const data = await alertsRes.json();
        setAlerts(data.alerts || []);
      } else {
        errors.push('アラート');
      }

      if (errors.length > 0) {
        toast.error('データ取得エラー', {
          description: `${errors.join('、')}の取得に失敗しました`,
        });
      }
    } catch {
      toast.error('接続エラー', {
        description: 'サーバーに接続できませんでした',
      });
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Handle WebSocket messages
  const handleMessage = useCallback((message: WebSocketMessage) => {
    switch (message.type) {
      case 'tasks':
        if (Array.isArray(message.payload)) {
          setTasks(message.payload as Task[]);
          addLogEntry('response', `${(message.payload as Task[]).length} タスクを受信`);
        }
        break;

      case 'task_update':
      case 'task-result':
        if (message.payload) {
          const updatedTask = message.payload as Task;
          setTasks((prev) =>
            prev.map((t) => (t.id === updatedTask.id ? { ...t, ...updatedTask } : t))
          );
          addLogEntry('response', `タスク更新: ${updatedTask.id}`);
          addActivity('task', updatedTask.status || '更新', updatedTask.title || updatedTask.id);
        }
        break;

      case 'task_created':
      case 'task':
        if (message.payload) {
          const newTask = message.payload as Task;
          setTasks((prev) => {
            if (prev.some((t) => t.id === newTask.id)) {
              return prev.map((t) => (t.id === newTask.id ? newTask : t));
            }
            return [newTask, ...prev];
          });
          addLogEntry('response', `新規タスク: ${newTask.id}`);
          addActivity('task', '作成', newTask.title || newTask.id);
        }
        break;

      case 'git-status':
        if (message.payload && Array.isArray((message.payload as { repos?: unknown[] }).repos)) {
          setRepos((message.payload as { repos: GitRepo[] }).repos);
          addLogEntry('response', 'Git状態を更新');
        }
        break;

      case 'alert':
        if (message.payload) {
          const newAlert = message.payload as Alert;
          setAlerts((prev) => {
            if (prev.some((a) => a.id === newAlert.id)) {
              return prev;
            }
            return [newAlert, ...prev].slice(0, 20);
          });
          toast.warning('新しいアラート', {
            description: newAlert.message || newAlert.id,
          });
          addLogEntry('system', `アラート: ${newAlert.message || newAlert.id}`);
          addActivity('alert', newAlert.severity || 'info', newAlert.message || newAlert.id);
        }
        break;

      case 'observability-sync':
        if (message.payload) {
          const data = message.payload as { provider_health?: ProviderStatus[] };
          if (data.provider_health) {
            setProviders(data.provider_health);
            addLogEntry('response', 'プロバイダー状態を更新');
          }
        }
        break;

      case 'ack':
        if (message.payload) {
          const ack = message.payload as { message?: string; taskId?: string; agentCount?: number };
          const logMsg = ack.message || 'コマンドを受理しました';
          addLogEntry('response', ack.agentCount !== undefined
            ? `${logMsg} (${ack.agentCount}エージェントに送信)`
            : logMsg);
        } else {
          addLogEntry('response', 'コマンドを受理しました');
        }
        break;

      case 'chat-response':
        if (message.payload) {
          const chatRes = message.payload as {
            taskId?: string;
            role?: string;
            content: string;
            timestamp?: number;
          };
          addLogEntry(
            chatRes.role === 'assistant' ? 'response' : 'system',
            chatRes.content
          );
        }
        break;

      case 'heartbeat':
        if (message.payload) {
          const heartbeat = message.payload as {
            message: string;
            type?: string;
            source?: string;
          };
          const source = heartbeat.source || 'Unknown';
          // Add to activity feed
          addActivity(
            'heartbeat',
            heartbeat.type || '通知',
            heartbeat.message
          );
          setRealtimeHeartbeats((prev) => {
            const updated = new Map(prev);
            updated.set(source, {
              type: heartbeat.type,
              message: heartbeat.message,
              timestamp: Date.now(),
              source,
            });
            return updated;
          });
          // Show toast only for non-OK heartbeats
          if (heartbeat.type !== 'HEARTBEAT_OK') {
            toast.info('HEARTBEAT', {
              description: heartbeat.message,
              duration: 5000,
            });
          }
          addLogEntry('system', `HEARTBEAT: ${heartbeat.message}`);
        }
        break;

      case 'command_pending':
        if (message.payload) {
          const pendingCmd = message.payload as PendingCommand;
          setPendingCommands((prev) => {
            if (prev.some((c) => c.id === pendingCmd.id)) return prev;
            return [pendingCmd, ...prev];
          });
          if (pendingCmd.requiresApproval) {
            toast.warning('承認が必要です', {
              description: pendingCmd.command.slice(0, 50),
              duration: 10000,
            });
          }
          addLogEntry('system', `承認待ち: ${pendingCmd.command.slice(0, 30)}...`);
          addActivity('command', '承認待ち', pendingCmd.command.slice(0, 50));
        }
        break;

      case 'command_approved':
        if (message.payload) {
          const { taskId } = message.payload as { taskId: string };
          setPendingCommands((prev) =>
            prev.map((c) => (c.id === taskId ? { ...c, status: 'approved' as const } : c))
          );
          addLogEntry('response', `コマンド承認: ${taskId}`);
        }
        break;

      case 'command_rejected':
        if (message.payload) {
          const { taskId } = message.payload as { taskId: string };
          setPendingCommands((prev) => prev.filter((c) => c.id !== taskId));
          addLogEntry('system', `コマンド拒否: ${taskId}`);
        }
        break;

      default:
        // Unknown message types are logged but not shown to user
        break;
    }
  }, [addLogEntry, addActivity]);

  // Handle WebSocket connection opened
  const handleOpen = useCallback(() => {
    // Dismiss any reconnect toast
    if (reconnectToastId.current) {
      toast.dismiss(reconnectToastId.current);
      reconnectToastId.current = undefined;
    }

    // Show toast only after initial connection or reconnection
    if (hasShownInitialToast.current) {
      toast.success('再接続しました', { duration: 2000 });
    } else {
      toast.success('接続しました', { duration: 2000 });
      hasShownInitialToast.current = true;
    }

    addLogEntry('system', '接続しました');
  }, [addLogEntry]);

  // Handle WebSocket connection closed
  const handleClose = useCallback(() => {
    addLogEntry('system', '接続が切断されました');
  }, [addLogEntry]);

  // Handle WebSocket error
  const handleError = useCallback((error: ErrorDetail) => {
    toast.error('接続エラー', {
      description: error.message,
    });
    addLogEntry('error', `エラー: ${error.message}`);
  }, [addLogEntry]);

  // Handle reconnecting
  const handleReconnecting = useCallback((state: ReconnectState) => {
    if (!reconnectToastId.current) {
      reconnectToastId.current = toast.loading('再接続中...', {
        description: `試行 ${state.attempt}/${state.maxAttempts} (${state.nextRetryIn}秒後)`,
        duration: Infinity,
      });
    } else {
      toast.loading('再接続中...', {
        id: reconnectToastId.current,
        description: `試行 ${state.attempt}/${state.maxAttempts} (${state.nextRetryIn}秒後)`,
      });
    }
    addLogEntry('system', `再接続中... (${state.attempt}/${state.maxAttempts})`);
  }, [addLogEntry]);

  // Handle max retries reached
  const handleMaxRetriesReached = useCallback(() => {
    if (reconnectToastId.current) {
      toast.dismiss(reconnectToastId.current);
      reconnectToastId.current = undefined;
    }
    toast.error('接続できませんでした', {
      description: '手動で再接続してください',
      duration: Infinity,
      action: {
        label: '再接続',
        onClick: () => {
          // This will be handled by the reconnect function
        },
      },
    });
    addLogEntry('error', '最大再接続回数に達しました');
  }, [addLogEntry]);

  const { state, send, reconnect, reconnectState } = useWebSocket({
    url: WS_URL,
    onMessage: handleMessage,
    onOpen: handleOpen,
    onClose: handleClose,
    onError: handleError,
    onReconnecting: handleReconnecting,
    onMaxRetriesReached: handleMaxRetriesReached,
  });

  // Use debounced state to prevent UI flickering
  const displayState = useDebouncedConnectionState(state);

  // Fetch initial data on mount
  useEffect(() => {
    fetchInitialData();
  }, [fetchInitialData]);

  // Request initial status when connected
  useEffect(() => {
    if (state === 'connected') {
      send({ type: 'status-request' });
    }
  }, [state, send]);

  // Handle command/chat input
  const handleCommand = useCallback(
    (input: string): boolean => {
      // Add to log as pending
      const isCommand = input.startsWith('/');
      addLogEntry(isCommand ? 'command' : 'system', input, 'pending');

      let success = false;

      // Parse command
      if (isCommand) {
        const [cmd, ...args] = input.slice(1).split(' ');

        switch (cmd) {
          case 'status':
            success = send({ type: 'status-request' });
            break;
          case 'tasks':
            fetchInitialData();
            success = true;
            break;
          case 'git':
            success = send({ type: 'status-request' });
            break;
          case 'help':
            toast.info('コマンド一覧', {
              description: '/status, /tasks, /git, /help またはチャットで指示',
              duration: 5000,
            });
            addLogEntry('response', 'ヘルプ: /status, /tasks, /git, /help またはチャットで指示');
            success = true;
            break;
          default:
            success = send({ type: 'command', payload: { command: cmd, args } });
        }
      } else {
        // Send as chat message
        success = send({ type: 'chat', payload: { message: input } });
        if (success) {
          toast.success('チャットを送信しました', {
            description: input.length > 50 ? input.slice(0, 50) + '...' : input,
            duration: 2000,
          });
        }
      }

      // Update log entry status
      setTimeout(() => {
        updateLogEntryStatus(input, success ? 'success' : 'error');
      }, 100);

      return success;
    },
    [send, fetchInitialData, addLogEntry, updateLogEntryStatus]
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
          toast.success('アラートを確認しました');
        } else {
          toast.error('アラートの確認に失敗しました');
        }
      } catch {
        toast.error('接続エラー');
      }
    },
    []
  );

  // Manual reconnect handler
  const handleReconnect = useCallback(() => {
    toast.loading('再接続中...', { duration: 2000 });
    reconnect();
  }, [reconnect]);

  // Handle command approval
  const handleApproveCommand = useCallback(async (commandId: string): Promise<boolean> => {
    const headers: HeadersInit = {
      'Content-Type': 'application/json',
    };
    if (API_KEY) {
      headers['Authorization'] = `Bearer ${API_KEY}`;
    }

    try {
      const res = await fetch(`${API_BASE}/cockpit/command/${commandId}/approve`, {
        method: 'POST',
        headers,
      });

      if (res.ok) {
        setPendingCommands((prev) =>
          prev.map((c) => (c.id === commandId ? { ...c, status: 'approved' as const } : c))
        );
        addActivity('command', '承認', commandId);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }, [addActivity]);

  // Handle command rejection
  const handleRejectCommand = useCallback(async (commandId: string): Promise<boolean> => {
    const headers: HeadersInit = {
      'Content-Type': 'application/json',
    };
    if (API_KEY) {
      headers['Authorization'] = `Bearer ${API_KEY}`;
    }

    try {
      const res = await fetch(`${API_BASE}/cockpit/command/${commandId}/reject`, {
        method: 'POST',
        headers,
      });

      if (res.ok) {
        setPendingCommands((prev) => prev.filter((c) => c.id !== commandId));
        addActivity('command', '拒否', commandId);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }, [addActivity]);

  const isConnected = displayState === 'connected';

  return (
    <div className="min-h-screen min-h-[100dvh] bg-zinc-100 dark:bg-zinc-950 flex flex-col">
      {/* Header */}
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
          <ConnectionStatus
            state={displayState}
            onReconnect={handleReconnect}
            reconnectState={reconnectState}
          />
        </div>
      </header>

      {/* Main content */}
      <main className="flex-1 overflow-y-auto px-4 py-4 pb-32 space-y-4">
        {/* Approval Queue (top priority - dangerous commands) */}
        <ApprovalQueue
          commands={pendingCommands}
          onApprove={handleApproveCommand}
          onReject={handleRejectCommand}
        />

        {/* Quick Actions */}
        <QuickActions onAction={handleCommand} disabled={!isConnected} />

        {/* System Metrics */}
        <SystemMetrics />

        {/* Alerts */}
        <AlertsList
          alerts={alerts}
          onAcknowledge={handleAcknowledgeAlert}
          maxVisible={3}
        />

        {/* Message Log */}
        <MessageLog
          entries={logEntries}
          maxVisible={3}
          onClear={clearLogEntries}
        />

        {/* Activity Feed */}
        <ActivityFeed activities={activities} maxVisible={5} />

        {/* Tasks */}
        <TaskList
          tasks={tasks}
          isLoading={isLoading && !isConnected}
          onTaskTap={(task) => {
            toast.info(`タスク: ${task.title || task.id}`, {
              description: task.status,
            });
          }}
        />

        {/* D1 Kanban Board */}
        <section className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 overflow-hidden">
          <div className="px-4 py-2 border-b border-zinc-200 dark:border-zinc-800">
            <h2 className="text-xs font-semibold text-zinc-500 dark:text-zinc-400 uppercase tracking-wide">
              D1 Kanban Board
            </h2>
          </div>
          <div className="p-4">
            {/* TODO: Re-enable after Server Actions migration to API routes */}
            <p className="text-sm text-zinc-500">Kanban Board is temporarily disabled (Server Actions → API migration pending)</p>
          </div>
        </section>

        {/* Git Repositories */}
        <GitRepoList
          repos={repos}
          onRepoTap={(repo) => {
            toast.info(`リポジトリ: ${repo.name || repo.path}`, {
              description: `ブランチ: ${repo.branch || 'unknown'}`,
            });
          }}
        />

        {/* Provider Health */}
        <ProviderHealth providers={providers} />

        {/* Daemon Status */}
        <DaemonStatus realtimeHeartbeats={realtimeHeartbeats} />

        {/* Settings */}
        <section className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 overflow-hidden">
          <div className="px-4 py-2 border-b border-zinc-200 dark:border-zinc-800">
            <h2 className="text-xs font-semibold text-zinc-500 dark:text-zinc-400 uppercase tracking-wide">
              設定
            </h2>
          </div>
          <PushSettings />
        </section>
      </main>

      {/* Command Input (sticky bottom) */}
      <div className="sticky bottom-0 z-20 safe-area-inset-bottom">
        <CommandInput
          onSend={handleCommand}
          disabled={!isConnected}
          placeholder={isConnected ? 'メッセージを入力... または /コマンド' : '接続中...'}
          isConnected={isConnected}
        />
      </div>
    </div>
  );
}
