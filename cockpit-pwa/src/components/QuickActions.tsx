'use client';

import { Button } from '@/components/ui/button';

interface QuickActionsProps {
  onAction: (action: string) => void;
  disabled?: boolean;
}

const actions = [
  { id: 'status', label: '/status', icon: '📊', description: 'システム状況' },
  { id: 'tasks', label: '/tasks', icon: '📋', description: 'タスク一覧' },
  { id: 'git', label: '/git', icon: '🔀', description: 'Git状況' },
  { id: 'help', label: '/help', icon: '❓', description: 'ヘルプ' },
];

export function QuickActions({ onAction, disabled }: QuickActionsProps) {
  return (
    <div className="flex gap-2 overflow-x-auto pb-2 -mx-4 px-4">
      {actions.map((action) => (
        <Button
          key={action.id}
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() => onAction(`/${action.id}`)}
          className="flex items-center gap-1.5 whitespace-nowrap text-xs"
        >
          <span>{action.icon}</span>
          <span>{action.label}</span>
        </Button>
      ))}
    </div>
  );
}
