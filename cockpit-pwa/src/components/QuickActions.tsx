'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';

interface QuickActionsProps {
  onAction: (action: string) => void;
  disabled?: boolean;
}

// Basic quick actions
const basicActions = [
  { id: 'status', label: '/status', icon: '📊', description: 'システム状況' },
  { id: 'tasks', label: '/tasks', icon: '📋', description: 'タスク一覧' },
  { id: 'git', label: '/git', icon: '🔀', description: 'Git状況' },
  { id: 'help', label: '/help', icon: '❓', description: 'ヘルプ' },
];

// FUGUE delegation quick actions (for Command Center)
const fugueActions = [
  {
    id: 'plan',
    label: '/plan',
    icon: '📝',
    description: '実装計画を作成',
    command: 'この機能の実装計画を立てて',
    executor: 'codex',
  },
  {
    id: 'review',
    label: '/review',
    icon: '🔍',
    description: 'コードレビュー',
    command: '最近の変更をレビューして',
    executor: 'glm',
  },
  {
    id: 'commit',
    label: '/commit',
    icon: '✅',
    description: 'コミット作成',
    command: '変更をコミットして',
    executor: 'codex',
  },
  {
    id: 'test',
    label: '/test',
    icon: '🧪',
    description: 'テスト実行',
    command: 'テストを実行して',
    executor: 'codex',
  },
];

export function QuickActions({ onAction, disabled }: QuickActionsProps) {
  const [showFugue, setShowFugue] = useState(false);

  return (
    <div className="space-y-2">
      {/* Basic actions */}
      <div className="flex gap-2 overflow-x-auto pb-2 -mx-4 px-4">
        {basicActions.map((action) => (
          <Button
            key={action.id}
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={() => onAction(`/${action.id}`)}
            className="flex items-center gap-1.5 whitespace-nowrap text-xs"
            title={action.description}
          >
            <span>{action.icon}</span>
            <span>{action.label}</span>
          </Button>
        ))}
        <Button
          variant={showFugue ? 'default' : 'outline'}
          size="sm"
          onClick={() => setShowFugue(!showFugue)}
          className="flex items-center gap-1.5 whitespace-nowrap text-xs"
          title="FUGUE クイックアクション"
        >
          <span>🎛️</span>
          <span>FUGUE</span>
        </Button>
      </div>

      {/* FUGUE delegation actions (expandable) */}
      {showFugue && (
        <div className="p-3 bg-gradient-to-r from-violet-50 to-blue-50 dark:from-violet-950/30 dark:to-blue-950/30 rounded-xl border border-violet-200 dark:border-violet-800 animate-fade-in">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-violet-600 dark:text-violet-400">🎛️</span>
            <h3 className="text-xs font-semibold text-violet-700 dark:text-violet-300 uppercase tracking-wide">
              FUGUE 委譲
            </h3>
          </div>
          <div className="flex gap-2 flex-wrap">
            {fugueActions.map((action) => (
              <Button
                key={action.id}
                variant="secondary"
                size="sm"
                disabled={disabled}
                onClick={() => onAction(action.command)}
                className="flex items-center gap-1.5 text-xs bg-white dark:bg-zinc-800 hover:bg-violet-100 dark:hover:bg-violet-900/30"
                title={`${action.description} (→ ${action.executor.toUpperCase()})`}
              >
                <span>{action.icon}</span>
                <span>{action.label}</span>
                <span className="text-[10px] text-zinc-400 dark:text-zinc-500">
                  {action.executor === 'codex' ? '🔷' : '🟢'}
                </span>
              </Button>
            ))}
          </div>
          <p className="mt-2 text-[10px] text-zinc-500 dark:text-zinc-400">
            🔷 Codex 🟢 GLM に委譲されます
          </p>
        </div>
      )}
    </div>
  );
}
