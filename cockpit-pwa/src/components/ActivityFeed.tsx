'use client';

import { useState } from 'react';
import { Badge } from '@/components/ui/badge';

export interface Activity {
  id: string;
  type: 'task' | 'git' | 'alert' | 'daemon' | 'system' | 'consensus' | 'heartbeat' | 'command';
  action: string;
  message: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

interface ActivityFeedProps {
  activities: Activity[];
  maxVisible?: number;
}

const typeIcons: Record<Activity['type'], string> = {
  task: '📋',
  git: '🔀',
  alert: '⚠️',
  daemon: '🤖',
  system: '⚙️',
  consensus: '🗳️',
  heartbeat: '💓',
  command: '⚡',
};

const typeColors: Record<Activity['type'], string> = {
  task: 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300',
  git: 'bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300',
  alert: 'bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-300',
  daemon: 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300',
  system: 'bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300',
  consensus: 'bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300',
  heartbeat: 'bg-cyan-100 dark:bg-cyan-900/30 text-cyan-700 dark:text-cyan-300',
  command: 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300',
};

function formatTimeAgo(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;

  if (diff < 60000) return '今';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}分前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}時間前`;
  return `${Math.floor(diff / 86400000)}日前`;
}

export function ActivityFeed({ activities, maxVisible = 5 }: ActivityFeedProps) {
  const [expanded, setExpanded] = useState(false);

  const visibleActivities = expanded ? activities : activities.slice(0, maxVisible);
  const hasMore = activities.length > maxVisible;

  if (activities.length === 0) {
    return (
      <section className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 overflow-hidden">
        <div className="px-4 py-2 border-b border-zinc-200 dark:border-zinc-800">
          <h2 className="text-xs font-semibold text-zinc-500 dark:text-zinc-400 uppercase tracking-wide">
            アクティビティ
          </h2>
        </div>
        <div className="p-4 text-center text-sm text-zinc-500 dark:text-zinc-400">
          アクティビティはありません
        </div>
      </section>
    );
  }

  return (
    <section className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 overflow-hidden">
      <div className="px-4 py-2 border-b border-zinc-200 dark:border-zinc-800 flex items-center justify-between">
        <h2 className="text-xs font-semibold text-zinc-500 dark:text-zinc-400 uppercase tracking-wide">
          アクティビティ
        </h2>
        <Badge variant="outline" className="text-xs">
          {activities.length}件
        </Badge>
      </div>

      <div className="divide-y divide-zinc-200 dark:divide-zinc-800">
        {visibleActivities.map((activity) => (
          <div
            key={activity.id}
            className="px-4 py-3 flex items-start gap-3 hover:bg-zinc-50 dark:hover:bg-zinc-800/50 transition-colors"
          >
            <span className="text-lg flex-shrink-0">{typeIcons[activity.type]}</span>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <Badge className={`text-xs ${typeColors[activity.type]}`}>
                  {activity.action}
                </Badge>
                <span className="text-xs text-zinc-400 dark:text-zinc-500">
                  {formatTimeAgo(activity.timestamp)}
                </span>
              </div>
              <p className="text-sm text-zinc-700 dark:text-zinc-300 truncate">
                {activity.message}
              </p>
            </div>
          </div>
        ))}
      </div>

      {hasMore && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="w-full px-4 py-2 text-xs text-center text-zinc-500 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-800/50 transition-colors border-t border-zinc-200 dark:border-zinc-800"
        >
          {expanded ? '折りたたむ' : `さらに${activities.length - maxVisible}件を表示`}
        </button>
      )}
    </section>
  );
}
