'use client';

import { useState, useEffect, useRef } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { ConnectionState, ReconnectState } from '@/hooks/useWebSocket';

interface ConnectionStatusProps {
  state: ConnectionState;
  onReconnect?: () => void;
  reconnectState?: ReconnectState | null;
}

const stateConfig: Record<ConnectionState, {
  label: string;
  variant: 'default' | 'secondary' | 'destructive' | 'outline';
  dot: string;
  animate?: boolean;
}> = {
  connecting: { label: '接続中', variant: 'secondary', dot: 'bg-yellow-500', animate: true },
  connected: { label: '接続済み', variant: 'default', dot: 'bg-green-500' },
  disconnected: { label: '切断', variant: 'outline', dot: 'bg-zinc-400' },
  reconnecting: { label: '再接続中', variant: 'secondary', dot: 'bg-yellow-500', animate: true },
  error: { label: 'エラー', variant: 'destructive', dot: 'bg-red-500', animate: true },
};

// Debounce delay: Only show state after it persists for this duration
const STATE_DEBOUNCE_MS = 500;

/**
 * Compact connection status indicator for mobile header
 * Enhanced with reconnection progress display
 */
export function ConnectionStatus({ state, onReconnect, reconnectState }: ConnectionStatusProps) {
  // Debounced state to prevent flickering during rapid state changes
  const [displayState, setDisplayState] = useState<ConnectionState>(state);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }

    // Immediately show 'connected' state (good news should be instant)
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Debounce pattern requires synchronous setState for immediate feedback
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

  const config = stateConfig[displayState];
  const showReconnect = (displayState === 'disconnected' || displayState === 'error') && onReconnect;
  const showProgress = displayState === 'reconnecting' && reconnectState;

  return (
    <div className="flex items-center gap-2">
      {/* Status indicator dot */}
      <div
        className={`
          w-2.5 h-2.5 rounded-full ${config.dot}
          ${displayState === 'connected' ? 'pulse-green' : ''}
          ${config.animate ? 'animate-pulse' : ''}
        `}
      />

      {/* Status badge */}
      <Badge variant={config.variant} className="text-xs px-2 py-0.5 transition-all duration-300">
        {config.label}
        {showProgress && (
          <span className="ml-1 opacity-75">
            ({reconnectState.attempt}/{reconnectState.maxAttempts})
          </span>
        )}
      </Badge>

      {/* Reconnect button */}
      {showReconnect && (
        <Button
          variant="ghost"
          size="sm"
          onClick={onReconnect}
          className="h-7 px-2 text-xs tap-scale"
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
export function ConnectionStatusCard({ state, onReconnect, reconnectState }: ConnectionStatusProps) {
  return (
    <div className="bg-white dark:bg-zinc-900 border rounded-lg p-3">
      <ConnectionStatus state={state} onReconnect={onReconnect} reconnectState={reconnectState} />
    </div>
  );
}
