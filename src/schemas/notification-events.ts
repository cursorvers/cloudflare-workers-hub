/**
 * Notification Events Schema - OpenClaw-inspired autonomous agent features
 *
 * Implements:
 * - Heartbeat pattern with proactive suggestions
 * - Priority-based notification queues (Critical/Normal separation)
 * - Device-independent state management
 * - Activity detection for intelligent timing
 *
 * @see https://github.com/openclaw/openclaw - Reference implementation
 */

import { z } from 'zod';

// =============================================================================
// Queue Mode (collect/steer/followup)
// =============================================================================

/**
 * Queue mode determines how notifications are batched and delivered
 * - on: Notifications are queued and delivered periodically
 * - off: Notifications are delivered immediately
 */
export const QueueModeSchema = z.enum(['on', 'off']);
export type QueueMode = z.infer<typeof QueueModeSchema>;

// =============================================================================
// Event Level (Priority classification)
// =============================================================================

/**
 * Event severity levels for UI differentiation
 * - critical: System errors, data loss risk → Toast notification, blocks workflow
 * - warning: Important but non-blocking → Toast notification, auto-dismiss
 * - info: General information → Ambient indicator
 * - suggestion: Proactive hints → Ambient indicator, throttled
 */
export const EventLevelSchema = z.enum(['critical', 'warning', 'info', 'suggestion']);
export type EventLevel = z.infer<typeof EventLevelSchema>;

// =============================================================================
// Notification Event
// =============================================================================

/**
 * Single notification event in the queue
 */
export const NotificationEventSchema = z.object({
  /** Unique event ID (UUID v4) */
  id: z.string().uuid(),
  /** Event severity level */
  level: EventLevelSchema,
  /** Short title (max 100 chars) */
  title: z.string().max(100),
  /** Detailed message (max 1000 chars) */
  message: z.string().max(1000),
  /** Unix timestamp (ms) when event was created */
  createdAt: z.number().int().positive(),
  /** Optional source identifier (e.g., "heartbeat", "git-monitor", "task-result") */
  source: z.string().max(50).optional(),
  /** Optional action button configuration */
  action: z.object({
    label: z.string().max(30),
    command: z.string().max(200),
  }).optional(),
  /** Optional metadata for debugging/analytics */
  metadata: z.record(z.unknown()).optional(),
});

export type NotificationEvent = z.infer<typeof NotificationEventSchema>;

// =============================================================================
// Queue State (Persisted in Durable Object)
// =============================================================================

/**
 * Queue state with priority separation
 * - Critical queue: max 5 events (never dropped, oldest first)
 * - Normal queue: max 15 events (FIFO overflow)
 */
export const QueueStateSchema = z.object({
  /** Queue mode */
  mode: QueueModeSchema,
  /** High-priority events (critical, warning) - max 5 */
  critical: z.array(NotificationEventSchema).max(5),
  /** Normal-priority events (info, suggestion) - max 15 */
  normal: z.array(NotificationEventSchema).max(15),
  /** Last update timestamp (ms) */
  updatedAt: z.number().int().positive(),
});

export type QueueState = z.infer<typeof QueueStateSchema>;

// =============================================================================
// Presence State (User activity detection)
// =============================================================================

/**
 * User presence states for intelligent notification timing
 * - active: User is actively working (keyboard, mouse, scroll within 60s)
 * - thinking: No input but browser/app focused (60s - 5min)
 * - away: No activity for 5+ minutes
 */
export const PresenceStateSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('active'),
    /** Last activity timestamp (ms) */
    lastActivityAt: z.number().int().positive(),
  }),
  z.object({
    state: z.literal('thinking'),
    /** When thinking state started (ms) */
    since: z.number().int().positive(),
  }),
  z.object({
    state: z.literal('away'),
    /** When away state started (ms) */
    since: z.number().int().positive(),
  }),
]);

export type PresenceState = z.infer<typeof PresenceStateSchema>;

// =============================================================================
// Suggestion Throttle (Anti-annoyance)
// =============================================================================

/**
 * Throttle configuration for suggestion notifications
 * Prevents "Clippy problem" - annoying frequent suggestions
 */
export const SuggestionThrottleSchema = z.object({
  /** Cooldown between suggestions (ms) - default 1 hour */
  cooldownMs: z.number().int().positive().default(3600000),
  /** Max suggestions per session - default 3 */
  sessionCap: z.number().int().positive().default(3),
  /** Last suggestion shown timestamp (ms) */
  lastShownAt: z.number().int().positive().optional(),
  /** Suggestions shown in current session */
  sessionCount: z.number().int().min(0).default(0),
});

export type SuggestionThrottle = z.infer<typeof SuggestionThrottleSchema>;

// =============================================================================
// Device Presence (Multi-device support)
// =============================================================================

/**
 * Device presence for multi-device coordination
 * Ensures suggestions go to the most recently active device only
 */
export const DevicePresenceSchema = z.object({
  /** Unique device identifier */
  deviceId: z.string().min(1).max(100),
  /** Last activity timestamp (ms) */
  lastActivityAt: z.number().int().positive(),
  /** Whether device is currently connected */
  isActive: z.boolean(),
  /** Device type for UI differentiation */
  deviceType: z.enum(['desktop', 'mobile', 'tablet', 'unknown']).optional(),
  /** User-friendly device name */
  deviceName: z.string().max(50).optional(),
});

export type DevicePresence = z.infer<typeof DevicePresenceSchema>;

// =============================================================================
// Heartbeat Configuration
// =============================================================================

/**
 * Heartbeat configuration for proactive agent behavior
 */
export const HeartbeatConfigSchema = z.object({
  /** Heartbeat interval (ms) - default 30 minutes */
  intervalMs: z.number().int().positive().default(1800000),
  /** Whether heartbeat is enabled */
  enabled: z.boolean().default(true),
  /** Max response length for acknowledgment */
  ackMaxChars: z.number().int().positive().default(300),
  /** Special token to suppress "nothing to report" responses */
  okToken: z.literal('HEARTBEAT_OK').optional(),
});

export type HeartbeatConfig = z.infer<typeof HeartbeatConfigSchema>;

// =============================================================================
// System Event (OpenClaw-compatible)
// =============================================================================

/**
 * System event for event queue (OpenClaw-compatible)
 */
export const SystemEventSchema = z.object({
  /** Event text content */
  text: z.string().max(2000),
  /** Unix timestamp (ms) */
  ts: z.number().int().positive(),
  /** Event category */
  category: z.enum(['connection', 'task', 'git', 'health', 'user']).optional(),
});

export type SystemEvent = z.infer<typeof SystemEventSchema>;

// =============================================================================
// WebSocket Message Types (for notification delivery)
// =============================================================================

/**
 * Notification message sent to PWA client
 */
export const NotificationMessageSchema = z.object({
  type: z.literal('notification'),
  payload: NotificationEventSchema,
});

export type NotificationMessage = z.infer<typeof NotificationMessageSchema>;

/**
 * Batch notification message (for queue flush)
 */
export const NotificationBatchSchema = z.object({
  type: z.literal('notification-batch'),
  payload: z.object({
    critical: z.array(NotificationEventSchema),
    normal: z.array(NotificationEventSchema),
  }),
});

export type NotificationBatch = z.infer<typeof NotificationBatchSchema>;

/**
 * Presence update message
 */
export const PresenceUpdateSchema = z.object({
  type: z.literal('presence-update'),
  payload: PresenceStateSchema,
});

export type PresenceUpdate = z.infer<typeof PresenceUpdateSchema>;

/**
 * Device heartbeat message (for presence tracking)
 */
export const DeviceHeartbeatSchema = z.object({
  type: z.literal('device-heartbeat'),
  payload: z.object({
    deviceId: z.string().min(1).max(100),
    /** Activity indicators */
    hasKeyboardActivity: z.boolean().optional(),
    hasMouseActivity: z.boolean().optional(),
    hasScrollActivity: z.boolean().optional(),
  }),
});

export type DeviceHeartbeat = z.infer<typeof DeviceHeartbeatSchema>;

/**
 * Notification dismiss message
 */
export const NotificationDismissSchema = z.object({
  type: z.literal('notification-dismiss'),
  payload: z.object({
    /** Event ID to dismiss */
    id: z.string().uuid(),
    /** Whether to suppress future similar notifications */
    dontShowAgain: z.boolean().optional(),
  }),
});

export type NotificationDismiss = z.infer<typeof NotificationDismissSchema>;

// =============================================================================
// Aggregated State (for DO persistence)
// =============================================================================

/**
 * P1 FIX: Track which devices have received which critical events
 * Maps eventId -> Set of deviceIds that have acknowledged receipt
 */
export const CriticalDeliveryTrackingSchema = z.record(
  z.string().uuid(), // eventId
  z.array(z.string()) // deviceIds that received this event
);

export type CriticalDeliveryTracking = z.infer<typeof CriticalDeliveryTrackingSchema>;

/**
 * Complete notification system state (persisted in DO)
 */
export const NotificationSystemStateSchema = z.object({
  /** Queue state with priority separation */
  queue: QueueStateSchema,
  /** User presence state */
  presence: PresenceStateSchema,
  /** Suggestion throttle configuration */
  throttle: SuggestionThrottleSchema,
  /** Connected devices */
  devices: z.array(DevicePresenceSchema),
  /** Heartbeat configuration */
  heartbeat: HeartbeatConfigSchema,
  /** Dismissed notification IDs/keys (for "don't show again") - stores source:level keys */
  dismissed: z.array(z.string()),
  /** P1 FIX: Track critical event delivery per device */
  criticalDelivered: CriticalDeliveryTrackingSchema.optional(),
  /** Last state sync timestamp */
  lastSyncAt: z.number().int().positive(),
});

export type NotificationSystemState = z.infer<typeof NotificationSystemStateSchema>;

// =============================================================================
// Default Values
// =============================================================================

/**
 * Default notification system state
 */
export const DEFAULT_NOTIFICATION_STATE: NotificationSystemState = {
  queue: {
    mode: 'on',
    critical: [],
    normal: [],
    updatedAt: Date.now(),
  },
  presence: {
    state: 'active',
    lastActivityAt: Date.now(),
  },
  throttle: {
    cooldownMs: 3600000, // 1 hour
    sessionCap: 3,
    sessionCount: 0,
  },
  devices: [],
  heartbeat: {
    intervalMs: 1800000, // 30 minutes
    enabled: true,
    ackMaxChars: 300,
  },
  dismissed: [],
  criticalDelivered: {}, // P1 FIX: Track critical event delivery per device
  lastSyncAt: Date.now(),
};

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Check if a suggestion can be shown (respects throttle)
 */
export function canShowSuggestion(throttle: SuggestionThrottle): boolean {
  const now = Date.now();

  // Check session cap
  if (throttle.sessionCount >= throttle.sessionCap) {
    return false;
  }

  // Check cooldown
  if (throttle.lastShownAt && now - throttle.lastShownAt < throttle.cooldownMs) {
    return false;
  }

  return true;
}

/**
 * Determine which device should receive suggestions
 * Returns the most recently active device
 */
export function getMostActiveDevice(devices: DevicePresence[]): DevicePresence | null {
  const activeDevices = devices.filter(d => d.isActive);
  if (activeDevices.length === 0) {
    return null;
  }

  return activeDevices.reduce((most, current) =>
    current.lastActivityAt > most.lastActivityAt ? current : most
  );
}

/**
 * Calculate presence state from activity timestamps
 */
export function calculatePresenceState(
  lastActivityAt: number,
  thinkingThresholdMs: number = 60000,  // 1 minute
  awayThresholdMs: number = 300000,     // 5 minutes
): PresenceState {
  const now = Date.now();
  const elapsed = now - lastActivityAt;

  if (elapsed < thinkingThresholdMs) {
    return { state: 'active', lastActivityAt };
  } else if (elapsed < awayThresholdMs) {
    return { state: 'thinking', since: lastActivityAt + thinkingThresholdMs };
  } else {
    return { state: 'away', since: lastActivityAt + awayThresholdMs };
  }
}

/**
 * Add event to queue with priority separation and overflow handling
 *
 * Overflow behavior:
 * - Critical queue: max 5, FIFO overflow (oldest removed when full)
 * - Normal queue: max 15, FIFO overflow (oldest removed when full)
 *
 * Both queues use the same overflow strategy to ensure bounded memory usage.
 */
export function addEventToQueue(
  queue: QueueState,
  event: NotificationEvent,
): QueueState {
  const isCritical = event.level === 'critical' || event.level === 'warning';

  if (isCritical) {
    // Critical queue: max 5, FIFO overflow (remove oldest when full)
    if (queue.critical.length >= 5) {
      const newCritical = [...queue.critical.slice(1), event];
      return { ...queue, critical: newCritical, updatedAt: Date.now() };
    }
    return { ...queue, critical: [...queue.critical, event], updatedAt: Date.now() };
  } else {
    // Normal queue: max 15, FIFO overflow (remove oldest when full)
    if (queue.normal.length >= 15) {
      const newNormal = [...queue.normal.slice(1), event];
      return { ...queue, normal: newNormal, updatedAt: Date.now() };
    }
    return { ...queue, normal: [...queue.normal, event], updatedAt: Date.now() };
  }
}
