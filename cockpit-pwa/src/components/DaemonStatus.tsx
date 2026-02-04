'use client';

import { useState, useEffect, useCallback } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { RealtimeHeartbeatMap } from '@/types/heartbeat';
import type { UsageResponse, UsageViewModel, UsageQuota } from '@/types/usage';

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
  realtimeHeartbeats?: RealtimeHeartbeatMap;
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

function formatHeartbeatAge(timestamp: number): string {
  const age = Math.round((Date.now() - timestamp) / 1000);
  if (age < 60) return `${age}秒前`;
  if (age < 3600) return `${Math.round(age / 60)}分前`;
  if (age < 86400) return `${Math.round(age / 3600)}時間前`;
  return `${Math.round(age / 86400)}日前`;
}

function getUsageStatus(percent: number): 'ok' | 'warn' | 'critical' {
  if (percent >= 95) return 'critical';
  if (percent >= 85) return 'warn';
  return 'ok';
}

function getAgentLabel(agent: string): string {
  const labels: Record<string, string> = {
    claude: 'Claude',
    codex: 'Codex',
    glm: 'GLM-4.7',
    gemini: 'Gemini',
  };
  return labels[agent] || agent;
}

function getPeriodLabel(period: string): string {
  const labels: Record<string, string> = {
    daily: '日次',
    weekly: '週次',
    monthly: '月次',
    '5h_rolling': '5時間',
    'monthly_web': '月次(Web)',
  };
  return labels[period] || period;
}

export function DaemonStatus({
  apiBase = '/api',
  apiKey = process.env.NEXT_PUBLIC_API_KEY,
  refreshInterval = 30000,
  realtimeHeartbeats,
}: DaemonStatusProps) {
  const [daemons, setDaemons] = useState<DaemonState[]>([]);
  const [staleDaemons, setStaleDaemons] = useState<DaemonState[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isExpanded, setIsExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [usageData, setUsageData] = useState<UsageResponse | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [expandedAgents, setExpandedAgents] = useState<Set<string>>(new Set());

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

  const fetchUsage = useCallback(async () => {
    const headers: HeadersInit = {
      'Content-Type': 'application/json',
    };
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    try {
      const res = await fetch(`${apiBase}/usage`, { headers });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data: UsageResponse = await res.json();
      setUsageData(data);
      setUsageError(null);
    } catch (err) {
      setUsageError(err instanceof Error ? err.message : 'Unknown error');
    }
  }, [apiBase, apiKey]);

  useEffect(() => {
    fetchDaemonHealth();
    const interval = setInterval(fetchDaemonHealth, refreshInterval);
    return () => clearInterval(interval);
  }, [fetchDaemonHealth, refreshInterval]);

  useEffect(() => {
    fetchUsage();
    const interval = setInterval(fetchUsage, 300000); // 5 minutes
    return () => clearInterval(interval);
  }, [fetchUsage]);

  const totalActive = daemons.length;
  const totalStale = staleDaemons.length;
  const hasIssues = totalStale > 0 || daemons.some(d => d.status !== 'healthy');
  const heartbeatEntries = Array.from(realtimeHeartbeats?.entries() ?? [])
    .sort(([, a], [, b]) => b.timestamp - a.timestamp);
  const showHeartbeatSection = realtimeHeartbeats !== undefined;

  return (
    <div className="space-y-2">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full text-sm font-semibold text-zinc-700 dark:text-zinc-300 px-1 flex items-center gap-2 hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors"
      >
        <span className={`transition-transform duration-200 ${isExpanded ? 'rotate-90' : ''}`}>
          ▶
        </span>
        <span>エージェント</span>
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
          {/* Daemon Health Section */}
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
              エージェントが登録されていません
            </div>
          ) : (
            <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
              {daemons.map((daemon) => (
                <DaemonRow key={daemon.daemonId} daemon={daemon} isStale={false} />
              ))}
              {staleDaemons.map((daemon) => (
                <DaemonRow key={daemon.daemonId} daemon={daemon} isStale={true} />
              ))}
            </ul>
          )}
          {/* HEARTBEAT Section - Always show when available */}
          {showHeartbeatSection && (
            <div className="border-t border-zinc-200 dark:border-zinc-800">
              <div className="px-4 py-2 text-xs font-semibold text-zinc-500 dark:text-zinc-400 uppercase tracking-wide">
                最新 HEARTBEAT
              </div>
              {heartbeatEntries.length === 0 ? (
                <div className="px-4 py-3 text-sm text-zinc-500 dark:text-zinc-400">
                  HEARTBEAT はまだありません
                </div>
              ) : (
                <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
                  {heartbeatEntries.map(([source, heartbeat]) => (
                    <li key={source} className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className="text-sm" aria-hidden="true">💓</span>
                        <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate">
                          {source}
                        </span>
                        <span className="text-xs text-zinc-500 dark:text-zinc-400">
                          {heartbeat.type || 'HEARTBEAT'}
                        </span>
                        <span className="text-xs text-zinc-400 dark:text-zinc-500 ml-auto">
                          {formatHeartbeatAge(heartbeat.timestamp)}
                        </span>
                      </div>
                      <p className="text-xs text-zinc-600 dark:text-zinc-400 truncate">
                        {heartbeat.message}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {/* AI Usage Section - Always show when available */}
          {usageData && (
            <div className="border-t border-zinc-200 dark:border-zinc-800">
              <div className="px-4 py-2 text-xs font-semibold text-zinc-500 dark:text-zinc-400 uppercase tracking-wide">
                AI 使用量
              </div>
              {usageError ? (
                <div className="px-4 py-3 text-sm text-red-500">
                  エラー: {usageError}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ml-2"
                    onClick={() => fetchUsage()}
                  >
                    再試行
                  </Button>
                </div>
              ) : (
                <ul className="divide-y divide-zinc-200 dark:border-zinc-800">
                  {(['claude', 'codex', 'glm', 'gemini'] as const).map((agent) => {
                    const agentData = usageData.agents[agent];
                    if (!agentData || !agentData.quotas.length) return null;

                    const criticalQuota = agentData.critical || agentData.quotas[0];
                    const percent = criticalQuota.limit > 0
                      ? Math.round((criticalQuota.used / criticalQuota.limit) * 100)
                      : 0;
                    const status = getUsageStatus(percent);
                    const isExpanded = expandedAgents.has(agent);

                    return (
                      <li key={agent} className="px-4 py-3">
                        <button
                          onClick={() => {
                            const newExpanded = new Set(expandedAgents);
                            if (isExpanded) {
                              newExpanded.delete(agent);
                            } else {
                              newExpanded.add(agent);
                            }
                            setExpandedAgents(newExpanded);
                          }}
                          className="w-full text-left"
                        >
                          <div className="flex items-center gap-2 mb-2">
                            <span className={`text-xs transition-transform duration-200 ${isExpanded ? 'rotate-90' : ''}`}>
                              ▶
                            </span>
                            <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                              {getAgentLabel(agent)}
                            </span>
                            <span className="text-xs text-zinc-500 dark:text-zinc-400">
                              {getPeriodLabel(criticalQuota.period)}
                            </span>
                            {status === 'critical' && (
                              <span className="text-xs text-red-500">⚠️</span>
                            )}
                            {status === 'warn' && (
                              <span className="text-xs text-yellow-500">⚠️</span>
                            )}
                          </div>
                          <QuotaBar quota={criticalQuota} />
                        </button>
                        {isExpanded && agentData.quotas.length > 1 && (
                          <div className="ml-4 mt-2 space-y-2">
                            {agentData.quotas
                              .filter(q => q !== criticalQuota)
                              .map((quota, idx) => (
                                <div key={idx}>
                                  <div className="text-xs text-zinc-500 dark:text-zinc-400 mb-1">
                                    {getPeriodLabel(quota.period)}
                                  </div>
                                  <QuotaBar quota={quota} />
                                </div>
                              ))}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface QuotaBarProps {
  quota: UsageQuota;
}

function QuotaBar({ quota }: QuotaBarProps) {
  const percent = quota.limit > 0
    ? Math.round((quota.used / quota.limit) * 100)
    : 0;
  const remaining = quota.limit - quota.used;
  const status = getUsageStatus(percent);

  const barColor = status === 'critical'
    ? 'bg-red-500'
    : status === 'warn'
    ? 'bg-yellow-500'
    : 'bg-blue-500';

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-zinc-600 dark:text-zinc-400">
          {quota.used}/{quota.limit} {quota.budget && `(${quota.budget})`}
        </span>
        <span className={`font-medium ${
          status === 'critical' ? 'text-red-500' :
          status === 'warn' ? 'text-yellow-600' :
          'text-zinc-600 dark:text-zinc-400'
        }`}>
          {percent}%
        </span>
      </div>
      <div className="w-full bg-zinc-200 dark:bg-zinc-700 rounded-full h-2 overflow-hidden">
        <div
          className={`${barColor} h-full transition-all duration-300`}
          style={{ width: `${Math.min(percent, 100)}%` }}
        />
      </div>
      {remaining > 0 && (
        <div className="text-xs text-zinc-500 dark:text-zinc-400">
          残り {remaining}
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
