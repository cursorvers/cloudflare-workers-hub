'use client';

import { useState, useEffect, useRef } from 'react';
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
  animate?: boolean;
}> = {
  connecting: { label: '接続中', variant: 'secondary', dot: 'bg-yellow-500', animate: true },
  connected: { label: '接続済み', variant: 'default', dot: 'bg-green-500' },
  disconnected: { label: '切断', variant: 'outline', dot: 'bg-zinc-400' },
  error: { label: 'エラー', variant: 'destructive', dot: 'bg-red-500', animate: true },
};

// Debounce delay: Only show state after it persists for this duration
const STATE_DEBOUNCE_MS = 500;

/**
 * Compact connection status indicator for mobile header
 * Gemini UI/UX Review: 省スペース化、メインコンテンツ表示領域を最大化
 *
 * Debouncing: Shows the last "stable" state to prevent flickering
 * during rapid reconnection cycles (connecting → error → connecting...)
 */
export function ConnectionStatus({ state, onReconnect }: ConnectionStatusProps) {
  // Debounced state to prevent flickering during rapid state changes
  const [displayState, setDisplayState] = useState<ConnectionState>(state);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    // Clear any pending state update
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

  const config = stateConfig[displayState];
  const showReconnect = (displayState === 'disconnected' || displayState === 'error') && onReconnect;

  return (
    <div className="flex items-center gap-2">
      {/* Status indicator dot with pulse animation for connected state */}
      <div className={`w-2.5 h-2.5 rounded-full ${config.dot} ${displayState === 'connected' ? 'pulse-green' : ''} ${config.animate ? 'animate-pulse' : ''}`} />

      {/* Status badge - compact */}
      <Badge variant={config.variant} className="text-xs px-2 py-0.5 transition-all duration-300">
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
