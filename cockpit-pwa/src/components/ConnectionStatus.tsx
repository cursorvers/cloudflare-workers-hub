'use client';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { ConnectionState } from '@/hooks/useWebSocket';

interface ConnectionStatusProps {
  state: ConnectionState;
  onReconnect?: () => void;
}

const stateConfig: Record<ConnectionState, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }> = {
  connecting: { label: '接続中...', variant: 'secondary' },
  connected: { label: '接続済み', variant: 'default' },
  disconnected: { label: '切断', variant: 'outline' },
  error: { label: 'エラー', variant: 'destructive' },
};

export function ConnectionStatus({ state, onReconnect }: ConnectionStatusProps) {
  const config = stateConfig[state];

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">接続状態</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between">
          <Badge variant={config.variant}>{config.label}</Badge>
          {(state === 'disconnected' || state === 'error') && onReconnect && (
            <button
              onClick={onReconnect}
              className="text-sm text-blue-600 hover:underline"
            >
              再接続
            </button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
