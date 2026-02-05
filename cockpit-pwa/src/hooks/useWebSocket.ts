'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { z } from 'zod';

// =============================================================================
// Types & Schemas
// =============================================================================

export type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'reconnecting' | 'error';

// Message schema for validation (XSS prevention)
const WebSocketMessageSchema = z.object({
  type: z.string(),
  payload: z.unknown().optional(),
  timestamp: z.string().optional(),
});

export type WebSocketMessage = z.infer<typeof WebSocketMessageSchema>;

export interface ReconnectState {
  attempt: number;
  maxAttempts: number;
  nextRetryIn: number; // seconds
}

export interface ErrorDetail {
  code: string;
  message: string;
  timestamp: Date;
}

export interface UseWebSocketOptions {
  url: string;
  onMessage?: (message: WebSocketMessage) => void;
  onOpen?: () => void;
  onClose?: () => void;
  onError?: (error: ErrorDetail) => void;
  onReconnecting?: (state: ReconnectState) => void;
  onMaxRetriesReached?: () => void;
  reconnect?: boolean;
  maxRetries?: number;
}

export interface UseWebSocketReturn {
  state: ConnectionState;
  send: (message: WebSocketMessage) => boolean; // Returns success status
  disconnect: () => void;
  reconnect: () => void;
  lastMessage: WebSocketMessage | null;
  reconnectState: ReconnectState | null;
  lastError: ErrorDetail | null;
}

// =============================================================================
// Constants
// =============================================================================

const INITIAL_RETRY_DELAY = 3000;
const MAX_RETRY_DELAY = 30000;
const BACKOFF_MULTIPLIER = 2;

// =============================================================================
// Hook
// =============================================================================

export function useWebSocket(options: UseWebSocketOptions): UseWebSocketReturn {
  const {
    url,
    onMessage,
    onOpen,
    onClose,
    onError,
    onReconnecting,
    onMaxRetriesReached,
    reconnect: shouldReconnect = true,
    maxRetries = 5,
  } = options;

  const [state, setState] = useState<ConnectionState>('disconnected');
  const [lastMessage, setLastMessage] = useState<WebSocketMessage | null>(null);
  const [reconnectState, setReconnectState] = useState<ReconnectState | null>(null);
  const [lastError, setLastError] = useState<ErrorDetail | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const retryCountRef = useRef(0);
  const retryDelayRef = useRef(INITIAL_RETRY_DELAY);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const mountedRef = useRef(true);
  const connectRef = useRef<() => void>(() => {});

  // Cleanup function
  const cleanup = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    if (wsRef.current) {
      wsRef.current.onopen = null;
      wsRef.current.onclose = null;
      wsRef.current.onerror = null;
      wsRef.current.onmessage = null;
      if (wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.close();
      }
      wsRef.current = null;
    }
  }, []);

  // Connect function
  const connect = useCallback(() => {
    if (!mountedRef.current) return;

    cleanup();
    setState('connecting');
    setLastError(null);

    try {
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        if (!mountedRef.current) return;
        setState('connected');
        retryCountRef.current = 0;
        retryDelayRef.current = INITIAL_RETRY_DELAY;
        setReconnectState(null);
        onOpen?.();
      };

      ws.onclose = (event) => {
        if (!mountedRef.current) return;

        // Create error detail for close event
        if (event.code !== 1000 && event.code !== 1001) {
          const errorDetail: ErrorDetail = {
            code: `CLOSE_${event.code}`,
            message: event.reason || getCloseCodeMessage(event.code),
            timestamp: new Date(),
          };
          setLastError(errorDetail);
        }

        onClose?.();

        // Exponential backoff reconnection
        if (shouldReconnect && retryCountRef.current < maxRetries) {
          setState('reconnecting');

          const nextRetryDelay = retryDelayRef.current;
          const newReconnectState: ReconnectState = {
            attempt: retryCountRef.current + 1,
            maxAttempts: maxRetries,
            nextRetryIn: Math.ceil(nextRetryDelay / 1000),
          };
          setReconnectState(newReconnectState);
          onReconnecting?.(newReconnectState);

          reconnectTimeoutRef.current = setTimeout(() => {
            retryCountRef.current += 1;
            retryDelayRef.current = Math.min(
              retryDelayRef.current * BACKOFF_MULTIPLIER,
              MAX_RETRY_DELAY
            );
            connectRef.current();
          }, nextRetryDelay);
        } else if (retryCountRef.current >= maxRetries) {
          setState('disconnected');
          setReconnectState(null);
          onMaxRetriesReached?.();
        } else {
          setState('disconnected');
          setReconnectState(null);
        }
      };

      ws.onerror = () => {
        if (!mountedRef.current) return;

        const errorDetail: ErrorDetail = {
          code: 'CONNECTION_ERROR',
          message: '接続エラーが発生しました',
          timestamp: new Date(),
        };
        setLastError(errorDetail);
        setState('error');
        onError?.(errorDetail);
      };

      ws.onmessage = (event) => {
        if (!mountedRef.current) return;

        try {
          const rawData = JSON.parse(event.data);
          const parseResult = WebSocketMessageSchema.safeParse(rawData);

          if (parseResult.success) {
            const message = parseResult.data;
            setLastMessage(message);
            onMessage?.(message);
          }
        } catch {
          // Silent fail for parse errors
        }
      };
    } catch {
      const errorDetail: ErrorDetail = {
        code: 'INIT_ERROR',
        message: 'WebSocket の初期化に失敗しました',
        timestamp: new Date(),
      };
      setLastError(errorDetail);
      setState('error');
      onError?.(errorDetail);
    }
  }, [url, onMessage, onOpen, onClose, onError, onReconnecting, onMaxRetriesReached, shouldReconnect, maxRetries, cleanup]);

  // Keep connectRef in sync (must be in useEffect for React 19)
  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  // Send function with validation - returns success status
  const send = useCallback((message: WebSocketMessage): boolean => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      const parseResult = WebSocketMessageSchema.safeParse(message);
      if (parseResult.success) {
        wsRef.current.send(JSON.stringify(parseResult.data));
        return true;
      }
    }
    return false;
  }, []);

  // Manual disconnect
  const disconnect = useCallback(() => {
    retryCountRef.current = maxRetries;
    cleanup();
    setState('disconnected');
    setReconnectState(null);
  }, [cleanup, maxRetries]);

  // Manual reconnect
  const manualReconnect = useCallback(() => {
    retryCountRef.current = 0;
    retryDelayRef.current = INITIAL_RETRY_DELAY;
    setLastError(null);
    connect();
  }, [connect]);

  // Auto-connect on mount
  useEffect(() => {
    mountedRef.current = true;
    connect();

    return () => {
      mountedRef.current = false;
      cleanup();
    };
  }, [connect, cleanup]);

  return {
    state,
    send,
    disconnect,
    reconnect: manualReconnect,
    lastMessage,
    reconnectState,
    lastError,
  };
}

// Helper function to get human-readable close code messages
function getCloseCodeMessage(code: number): string {
  const messages: Record<number, string> = {
    1000: '正常終了',
    1001: 'ページを離れました',
    1002: 'プロトコルエラー',
    1003: 'サポートされていないデータ型',
    1006: '異常終了（接続断）',
    1007: 'データ形式エラー',
    1008: 'ポリシー違反',
    1009: 'メッセージが大きすぎます',
    1010: '拡張が必要です',
    1011: 'サーバーエラー',
    1015: 'TLS ハンドシェイク失敗',
    4001: '認証エラー',
    4003: '権限がありません',
  };
  return messages[code] || `不明なエラー (${code})`;
}
