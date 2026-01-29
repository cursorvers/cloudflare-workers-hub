'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { z } from 'zod';

// =============================================================================
// Types & Schemas
// =============================================================================

export type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'error';

// Message schema for validation (XSS prevention)
const WebSocketMessageSchema = z.object({
  type: z.string(),
  payload: z.unknown().optional(),
  timestamp: z.string().optional(),
});

export type WebSocketMessage = z.infer<typeof WebSocketMessageSchema>;

export interface UseWebSocketOptions {
  url: string;
  onMessage?: (message: WebSocketMessage) => void;
  onOpen?: () => void;
  onClose?: () => void;
  onError?: (error: Event) => void;
  reconnect?: boolean;
  maxRetries?: number;
}

export interface UseWebSocketReturn {
  state: ConnectionState;
  send: (message: WebSocketMessage) => void;
  disconnect: () => void;
  reconnect: () => void;
  lastMessage: WebSocketMessage | null;
}

// =============================================================================
// Constants
// =============================================================================

const INITIAL_RETRY_DELAY = 1000;
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
    reconnect: shouldReconnect = true,
    maxRetries = 5,
  } = options;

  const [state, setState] = useState<ConnectionState>('disconnected');
  const [lastMessage, setLastMessage] = useState<WebSocketMessage | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const retryCountRef = useRef(0);
  const retryDelayRef = useRef(INITIAL_RETRY_DELAY);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const mountedRef = useRef(true);

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

    try {
      // Note: Cloudflare Access cookies are sent automatically
      // No need to manually add authentication headers
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        if (!mountedRef.current) return;
        setState('connected');
        retryCountRef.current = 0;
        retryDelayRef.current = INITIAL_RETRY_DELAY;
        onOpen?.();
      };

      ws.onclose = () => {
        if (!mountedRef.current) return;
        setState('disconnected');
        onClose?.();

        // Exponential backoff reconnection
        if (shouldReconnect && retryCountRef.current < maxRetries) {
          reconnectTimeoutRef.current = setTimeout(() => {
            retryCountRef.current += 1;
            retryDelayRef.current = Math.min(
              retryDelayRef.current * BACKOFF_MULTIPLIER,
              MAX_RETRY_DELAY
            );
            connect();
          }, retryDelayRef.current);
        }
      };

      ws.onerror = (event) => {
        if (!mountedRef.current) return;
        setState('error');
        onError?.(event);
      };

      ws.onmessage = (event) => {
        if (!mountedRef.current) return;

        try {
          const rawData = JSON.parse(event.data);

          // Validate message schema (XSS prevention)
          const parseResult = WebSocketMessageSchema.safeParse(rawData);

          if (parseResult.success) {
            const message = parseResult.data;
            setLastMessage(message);
            onMessage?.(message);
          } else {
            console.warn('[WebSocket] Invalid message format:', parseResult.error);
          }
        } catch (err) {
          console.warn('[WebSocket] Failed to parse message:', err);
        }
      };
    } catch (err) {
      setState('error');
      console.error('[WebSocket] Connection error:', err);
    }
  }, [url, onMessage, onOpen, onClose, onError, shouldReconnect, maxRetries, cleanup]);

  // Send function with validation
  const send = useCallback((message: WebSocketMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      // Validate outgoing message
      const parseResult = WebSocketMessageSchema.safeParse(message);
      if (parseResult.success) {
        wsRef.current.send(JSON.stringify(parseResult.data));
      } else {
        console.error('[WebSocket] Invalid message format:', parseResult.error);
      }
    } else {
      console.warn('[WebSocket] Cannot send: connection not open');
    }
  }, []);

  // Manual disconnect
  const disconnect = useCallback(() => {
    retryCountRef.current = maxRetries; // Prevent auto-reconnect
    cleanup();
    setState('disconnected');
  }, [cleanup, maxRetries]);

  // Manual reconnect
  const manualReconnect = useCallback(() => {
    retryCountRef.current = 0;
    retryDelayRef.current = INITIAL_RETRY_DELAY;
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
  };
}
