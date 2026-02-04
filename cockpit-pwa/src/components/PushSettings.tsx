'use client';

import { usePushNotifications } from '@/hooks/usePushNotifications';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

export function PushSettings() {
  const {
    isSupported,
    permission,
    isSubscribed,
    isLoading,
    error,
    subscribe,
    unsubscribe,
  } = usePushNotifications();

  if (!isSupported) {
    return (
      <div className="px-4 py-3 text-sm text-zinc-500 dark:text-zinc-400">
        このブラウザはプッシュ通知に対応していません
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between px-4 py-3">
      <div className="flex items-center gap-2">
        <span className="text-sm text-zinc-700 dark:text-zinc-300">
          プッシュ通知
        </span>
        {isSubscribed ? (
          <Badge variant="default" className="text-xs">有効</Badge>
        ) : (
          <Badge variant="outline" className="text-xs">無効</Badge>
        )}
        {permission === 'denied' && (
          <Badge variant="destructive" className="text-xs">ブロック中</Badge>
        )}
      </div>

      <div className="flex items-center gap-2">
        {error && (
          <span className="text-xs text-red-500">{error}</span>
        )}

        {isSubscribed ? (
          <Button
            variant="outline"
            size="sm"
            onClick={unsubscribe}
            disabled={isLoading}
            className="text-xs"
          >
            {isLoading ? '処理中...' : '無効にする'}
          </Button>
        ) : (
          <Button
            variant="default"
            size="sm"
            onClick={subscribe}
            disabled={isLoading || permission === 'denied'}
            className="text-xs"
          >
            {isLoading ? '処理中...' : '有効にする'}
          </Button>
        )}
      </div>
    </div>
  );
}
