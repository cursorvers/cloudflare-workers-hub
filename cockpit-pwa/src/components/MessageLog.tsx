'use client';

import { useState, useCallback, useEffect, useRef } from 'react';

export interface LogEntry {
  id: string;
  type: 'command' | 'response' | 'error' | 'system';
  content: string;
  timestamp: Date;
  status?: 'pending' | 'success' | 'error';
}

interface MessageLogProps {
  entries: LogEntry[];
  maxVisible?: number;
  onClear?: () => void;
}

const DEFAULT_VISIBLE = 3;
const MAX_ENTRIES = 20;

/**
 * MessageLog - コマンド履歴とレスポンスの可視化
 * 折りたたみ可能、タイムスタンプ付き
 */
export function MessageLog({
  entries,
  maxVisible = DEFAULT_VISIBLE,
  onClear,
}: MessageLogProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new entries
  useEffect(() => {
    if (scrollRef.current && entries.length > 0) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [entries.length]);

  const visibleEntries = isExpanded
    ? entries.slice(-MAX_ENTRIES)
    : entries.slice(-maxVisible);

  const hasMore = entries.length > maxVisible;

  if (entries.length === 0) {
    return null;
  }

  return (
    <div className="bg-white dark:bg-zinc-900/80 border border-zinc-200 dark:border-zinc-800 rounded-xl overflow-hidden section-animate">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900">
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="flex items-center gap-2 text-sm font-medium text-zinc-600 dark:text-zinc-400 tap-scale"
        >
          <span className="text-base">📋</span>
          <span>コマンド履歴</span>
          <span className="text-xs text-zinc-400">
            ({entries.length})
          </span>
          <ChevronIcon className={`w-4 h-4 transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
        </button>

        {onClear && entries.length > 0 && (
          <button
            onClick={onClear}
            className="text-xs text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 tap-scale"
          >
            クリア
          </button>
        )}
      </div>

      {/* Log entries */}
      <div
        ref={scrollRef}
        className={`
          overflow-y-auto transition-all duration-300
          ${isExpanded ? 'max-h-60' : 'max-h-32'}
        `}
      >
        <div className="p-2 space-y-1">
          {visibleEntries.map((entry) => (
            <LogEntryRow key={entry.id} entry={entry} />
          ))}
        </div>
      </div>

      {/* Expand hint */}
      {hasMore && !isExpanded && (
        <button
          onClick={() => setIsExpanded(true)}
          className="w-full py-1.5 text-xs text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 border-t border-zinc-200 dark:border-zinc-800 tap-scale"
        >
          さらに {entries.length - maxVisible} 件を表示
        </button>
      )}
    </div>
  );
}

function LogEntryRow({ entry }: { entry: LogEntry }) {
  const typeConfig = {
    command: {
      icon: '▶',
      color: 'text-blue-500',
      bg: 'bg-blue-500/5',
    },
    response: {
      icon: '✓',
      color: 'text-green-500',
      bg: 'bg-green-500/5',
    },
    error: {
      icon: '✗',
      color: 'text-red-500',
      bg: 'bg-red-500/5',
    },
    system: {
      icon: '●',
      color: 'text-zinc-400',
      bg: 'bg-zinc-500/5',
    },
  };

  const config = typeConfig[entry.type];
  const time = formatTime(entry.timestamp);

  return (
    <div
      className={`
        flex items-start gap-2 px-2 py-1.5 rounded-lg text-sm
        ${config.bg}
        ${entry.status === 'pending' ? 'animate-pulse' : ''}
        animate-fade-in
      `}
    >
      <span className="text-xs text-zinc-400 font-mono shrink-0 pt-0.5">
        {time}
      </span>
      <span className={`${config.color} shrink-0`}>
        {entry.status === 'pending' ? (
          <span className="inline-block w-3 h-3 border border-current border-t-transparent rounded-full animate-spin" />
        ) : (
          config.icon
        )}
      </span>
      <span className="text-zinc-700 dark:text-zinc-300 break-all">
        {entry.content}
      </span>
    </div>
  );
}

function ChevronIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
    </svg>
  );
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString('ja-JP', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

// Helper to create a log entry
export function createLogEntry(
  type: LogEntry['type'],
  content: string,
  status?: LogEntry['status']
): LogEntry {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    type,
    content,
    timestamp: new Date(),
    status,
  };
}
