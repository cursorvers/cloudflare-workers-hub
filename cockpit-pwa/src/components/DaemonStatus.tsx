'use client';

import { useState, useEffect, useCallback } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

export interface DaemonState {
  daemonId: string;
  version: string;
  capabilities: string[];
  lastHeartbeat: string;
  status: 'healthy' | 'degraded' | 'unhealthy';
  tasksProcessed: number;
  currentTask?: string;
}

interface DaemonStatusProps {
  apiBase?: string;
  apiKey?: string;
  refreshInterval?: number; // ms, default 30000
}

const statusConfig: Record<DaemonState['status'], {
  label: string;
  variant: 'default' | 'secondary' | 'destructive' | 'outline';
  icon: string;
}> = {
  healthy: { label: 'Healthy', variant: 'default', icon: '🟢' },
  degraded: { label: 'Degraded', variant: 'secondary', icon: '🟡' },
  unhealthy: { label: 'Unhealthy', variant: 'destructive', icon: '🔴' },
};

function formatAge(isoString: string): string {
  const age = Math.round((Date.now() - new Date(isoString).getTime()) / 1000);
  if (age < 60) return `${age}秒前`;
  if (age < 3600) return `${Math.round(age / 60)}分前`;
  return `${Math.round(age / 3600)}時間前`;
}

export function DaemonStatus({
  apiBase = process.env.NEXT_PUBLIC_API_URL || 'https://orchestrator-hub.masa-stage1.workers.dev/api',
  apiKey = process.env.NEXT_PUBLIC_API_KEY,
  refreshInterval = 30000,
}: DaemonStatusProps) {
  const [daemons, setDaemons] = useState<DaemonState[]>([]);
  const [staleDaemons, setStaleDaemons] = useState<DaemonState[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isExpanded, setIsExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchDaemonHealth = useCallback(async () => {
    const headers: HeadersInit = {
      'Content-Type': 'application/json',
    };
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    try {
      const res = await fetch(`${apiBase}/daemon/health`, { headers });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = await res.json();
      setDaemons(data.activeDaemons || []);
      setStaleDaemons(data.stale || []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setIsLoading(false);
    }
  }, [apiBase, apiKey]);

  useEffect(() => {
    fetchDaemonHealth();
    const interval = setInterval(fetchDaemonHealth, refreshInterval);
    return () => clearInterval(interval);
  }, [fetchDaemonHealth, refreshInterval]);

  const totalActive = daemons.length;
  const totalStale = staleDaemons.length;
  const hasIssues = totalStale > 0 || daemons.some(d => d.status !== 'healthy');

  return (
    <div className="space-y-2">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full text-sm font-semibold text-zinc-700 dark:text-zinc-300 px-1 flex items-center gap-2 hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors"
      >
        <span className={`transition-transform duration-200 ${isExpanded ? 'rotate-90' : ''}`}>
          ▶
        </span>
        <span>デーモン</span>
        {isLoading ? (
          <Badge variant="outline" className="text-xs">読込中...</Badge>
        ) : error ? (
          <Badge variant="destructive" className="text-xs">エラー</Badge>
        ) : hasIssues ? (
          <Badge variant="destructive" className="text-xs">
            {totalStale > 0 ? `${totalStale} stale` : 'issues'}
          </Badge>
        ) : totalActive > 0 ? (
          <Badge variant="default" className="text-xs">
            {totalActive} active
          </Badge>
        ) : (
          <Badge variant="outline" className="text-xs">なし</Badge>
        )}
        <span className="text-xs text-zinc-400 ml-auto">
          {totalActive + totalStale} total
        </span>
      </button>

      {isExpanded && (
        <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 overflow-hidden animate-fade-in">
          {error ? (
            <div className="px-4 py-3 text-sm text-red-500">
              エラー: {error}
              <Button
                variant="ghost"
                size="sm"
                className="ml-2"
                onClick={() => {
                  setIsLoading(true);
                  fetchDaemonHealth();
                }}
              >
                再試行
              </Button>
            </div>
          ) : totalActive === 0 && totalStale === 0 ? (
            <div className="px-4 py-3 text-sm text-zinc-500 dark:text-zinc-400">
              デーモンが登録されていません
            </div>
          ) : (
            <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
              {/* Active Daemons */}
              {daemons.map((daemon) => (
                <DaemonRow key={daemon.daemonId} daemon={daemon} isStale={false} />
              ))}
              {/* Stale Daemons */}
              {staleDaemons.map((daemon) => (
                <DaemonRow key={daemon.daemonId} daemon={daemon} isStale={true} />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

interface DaemonRowProps {
  daemon: DaemonState;
  isStale: boolean;
}

function DaemonRow({ daemon, isStale }: DaemonRowProps) {
  const config = isStale
    ? { label: 'Stale', variant: 'destructive' as const, icon: '⚫' }
    : statusConfig[daemon.status];

  return (
    <li className={`flex items-center justify-between px-4 py-3 ${isStale ? 'opacity-60' : ''}`}>
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-sm flex-shrink-0" aria-hidden="true">
          {config.icon}
        </span>
        <div className="min-w-0">
          <span className="font-medium text-zinc-900 dark:text-zinc-100 text-sm truncate block">
            {daemon.daemonId}
          </span>
          <span className="text-xs text-zinc-500 dark:text-zinc-400">
            v{daemon.version} • {formatAge(daemon.lastHeartbeat)}
          </span>
        </div>
      </div>

      <div className="flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400 flex-shrink-0">
        {/* Tasks processed */}
        <span className="font-mono">
          {daemon.tasksProcessed} tasks
        </span>

        {/* Current task indicator */}
        {daemon.currentTask && (
          <span className="text-blue-500" title={daemon.currentTask}>
            ⏳
          </span>
        )}

        {/* Status badge */}
        <Badge variant={config.variant} className="text-xs">
          {config.label}
        </Badge>
      </div>
    </li>
  );
}
