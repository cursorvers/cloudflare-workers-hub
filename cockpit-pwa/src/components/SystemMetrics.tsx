'use client';

import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';

interface Metrics {
  activeConnections: number;
  pendingTasks: number;
  completedToday: number;
  failedToday: number;
  avgResponseTime: number;
  uptime: string;
}

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'https://orchestrator-hub.masa-stage1.workers.dev/api';
const API_KEY = process.env.NEXT_PUBLIC_API_KEY;

export function SystemMetrics() {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const fetchMetrics = async () => {
      try {
        const headers: HeadersInit = { 'Content-Type': 'application/json' };
        if (API_KEY) headers['Authorization'] = `Bearer ${API_KEY}`;

        const response = await fetch(`${API_BASE}/health`, { headers });
        if (response.ok) {
          const data = await response.json();
          setMetrics({
            activeConnections: data.connections || 0,
            pendingTasks: data.pendingTasks || 0,
            completedToday: data.completedToday || 0,
            failedToday: data.failedToday || 0,
            avgResponseTime: data.avgResponseTime || 0,
            uptime: data.uptime || '不明',
          });
        }
      } catch {
        // Silently fail - metrics are optional
      } finally {
        setIsLoading(false);
      }
    };

    fetchMetrics();
    const interval = setInterval(fetchMetrics, 30000); // Refresh every 30s
    return () => clearInterval(interval);
  }, []);

  // Show placeholder metrics if API not available
  const displayMetrics = metrics || {
    activeConnections: 1,
    pendingTasks: 0,
    completedToday: 0,
    failedToday: 0,
    avgResponseTime: 0,
    uptime: '稼働中',
  };

  return (
    <section className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 overflow-hidden">
      <div className="px-4 py-2 border-b border-zinc-200 dark:border-zinc-800 flex items-center justify-between">
        <h2 className="text-xs font-semibold text-zinc-500 dark:text-zinc-400 uppercase tracking-wide">
          システム状況
        </h2>
        <Badge variant="outline" className="text-xs">
          {isLoading ? '読込中...' : displayMetrics.uptime}
        </Badge>
      </div>

      <div className="grid grid-cols-2 gap-px bg-zinc-200 dark:bg-zinc-800">
        <MetricCard
          label="アクティブ接続"
          value={displayMetrics.activeConnections}
          suffix="件"
          color="blue"
        />
        <MetricCard
          label="保留タスク"
          value={displayMetrics.pendingTasks}
          suffix="件"
          color={displayMetrics.pendingTasks > 5 ? 'yellow' : 'green'}
        />
        <MetricCard
          label="今日完了"
          value={displayMetrics.completedToday}
          suffix="件"
          color="green"
        />
        <MetricCard
          label="今日失敗"
          value={displayMetrics.failedToday}
          suffix="件"
          color={displayMetrics.failedToday > 0 ? 'red' : 'green'}
        />
      </div>
    </section>
  );
}

function MetricCard({
  label,
  value,
  suffix,
  color,
}: {
  label: string;
  value: number;
  suffix: string;
  color: 'blue' | 'green' | 'yellow' | 'red';
}) {
  const colorClasses = {
    blue: 'text-blue-600 dark:text-blue-400',
    green: 'text-green-600 dark:text-green-400',
    yellow: 'text-yellow-600 dark:text-yellow-400',
    red: 'text-red-600 dark:text-red-400',
  };

  return (
    <div className="bg-white dark:bg-zinc-900 p-3">
      <div className="text-xs text-zinc-500 dark:text-zinc-400 mb-1">{label}</div>
      <div className={`text-xl font-bold ${colorClasses[color]}`}>
        {value}
        <span className="text-sm font-normal ml-1">{suffix}</span>
      </div>
    </div>
  );
}
