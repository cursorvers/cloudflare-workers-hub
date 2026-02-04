/**
 * HEARTBEAT information from WebSocket messages
 * Used to display real-time heartbeat status in DaemonStatus component
 */
export interface HeartbeatInfo {
  /** Type of heartbeat (e.g., "Morning Start", "Midday Check", "Evening Review") */
  type?: string;
  /** Heartbeat message content */
  message: string;
  /** Timestamp when heartbeat was received (Date.now()) */
  timestamp: number;
  /** Source of the heartbeat (e.g., "OpenClaw HEARTBEAT") */
  source: string;
}

export type RealtimeHeartbeatMap = Map<string, HeartbeatInfo>;
