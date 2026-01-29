'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { ConnectionState } from '@/hooks/useWebSocket';

interface ConnectionStatusProps {
  state: ConnectionState;
  onReconnect?: () => void;
}

const stateConfig: Record<ConnectionState, {
  label: string;
  variant: 'default' | 'secondary' | 'destructive' | 'outline';
  dot: string;
}> = {
  connecting: { label: '接続中', variant: 'secondary', dot: 'bg-yellow-500 animate-pulse' },
  connected: { label: '接続済み', variant: 'default', dot: 'bg-green-500' },
  disconnected: { label: '切断', variant: 'outline', dot: 'bg-zinc-400' },
  error: { label: 'エラー', variant: 'destructive', dot: 'bg-red-500' },
};

/**
 * Compact connection status indicator for mobile header
 * Gemini UI/UX Review: 省スペース化、メインコンテンツ表示領域を最大化
 */
export function ConnectionStatus({ state, onReconnect }: ConnectionStatusProps) {
  const config = stateConfig[state];
  const showReconnect = (state === 'disconnected' || state === 'error') && onReconnect;

  return (
    <div className="flex items-center gap-2">
      {/* Status indicator dot */}
      <div className={`w-2.5 h-2.5 rounded-full ${config.dot}`} />

      {/* Status badge - compact */}
      <Badge variant={config.variant} className="text-xs px-2 py-0.5">
        {config.label}
      </Badge>

      {/* Reconnect button - only when needed */}
      {showReconnect && (
        <Button
          variant="ghost"
          size="sm"
          onClick={onReconnect}
          className="h-7 px-2 text-xs"
        >
          再接続
        </Button>
      )}
    </div>
  );
}

/**
 * Full card version for desktop (optional)
 */
export function ConnectionStatusCard({ state, onReconnect }: ConnectionStatusProps) {
  return (
    <div className="bg-white dark:bg-zinc-900 border rounded-lg p-3">
      <ConnectionStatus state={state} onReconnect={onReconnect} />
    </div>
  );
}
