/**
 * SystemEvents Durable Object
 *
 * Manages notification events, device presence, and suggestion throttling
 * for the OpenClaw-inspired autonomous agent features.
 *
 * ## Key Features
 * - Priority-based event queues (Critical 5 + Normal 15)
 * - Device-independent state (Edge-centralized)
 * - Presence tracking for intelligent notification timing
 * - Suggestion throttling to prevent "Clippy problem"
 *
 * ## Device Independence Strategy
 * - All state lives here in the DO
 * - Local Agents are stateless, just report activity
 * - Suggestions only go to most recently active device
 * - Critical notifications sync across all devices
 */

import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../types';
import { safeLog } from '../utils/log-sanitizer';
import {
  type NotificationEvent,
  type NotificationSystemState,
  type DevicePresence,
  type QueueState,
  type PresenceState,
  NotificationEventSchema,
  DeviceHeartbeatSchema,
  NotificationDismissSchema,
  DEFAULT_NOTIFICATION_STATE,
  canShowSuggestion,
  getMostActiveDevice,
  calculatePresenceState,
  addEventToQueue,
} from '../schemas/notification-events';
import { z } from 'zod';

// =============================================================================
// Internal Schemas
// =============================================================================

const AddEventRequestSchema = z.object({
  type: z.literal('add-event'),
  event: NotificationEventSchema,
});

const GetStateRequestSchema = z.object({
  type: z.literal('get-state'),
});

const DismissEventRequestSchema = z.object({
  type: z.literal('dismiss'),
  eventId: z.string().uuid(),
  dontShowAgain: z.boolean().optional(),
});

const DeviceActivityRequestSchema = z.object({
  type: z.literal('device-activity'),
  deviceId: z.string().min(1).max(100),
  deviceType: z.enum(['desktop', 'mobile', 'tablet', 'unknown']).optional(),
  deviceName: z.string().max(50).optional(),
  hasActivity: z.boolean(),
});

const FlushQueueRequestSchema = z.object({
  type: z.literal('flush-queue'),
  deviceId: z.string().min(1).max(100).optional(),
});

const InternalRequestSchema = z.discriminatedUnion('type', [
  AddEventRequestSchema,
  GetStateRequestSchema,
  DismissEventRequestSchema,
  DeviceActivityRequestSchema,
  FlushQueueRequestSchema,
]);

type InternalRequest = z.infer<typeof InternalRequestSchema>;

// =============================================================================
// SystemEvents Durable Object
// =============================================================================

export class SystemEvents extends DurableObject<Env> {
  private state: NotificationSystemState = DEFAULT_NOTIFICATION_STATE;
  private initialized = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    // Restore state on initialization
    this.ctx.blockConcurrencyWhile(async () => {
      await this.loadState();
    });

    // Set up periodic cleanup alarm (every 5 minutes)
    this.ctx.storage.setAlarm(Date.now() + 300000);
  }

  /**
   * Load state from durable storage
   */
  private async loadState(): Promise<void> {
    const stored = await this.ctx.storage.get<NotificationSystemState>('systemEventsState');
    if (stored) {
      this.state = stored;
      safeLog.log('[SystemEvents] State loaded', {
        criticalCount: this.state.queue.critical.length,
        normalCount: this.state.queue.normal.length,
        deviceCount: this.state.devices.length,
      });
    } else {
      this.state = { ...DEFAULT_NOTIFICATION_STATE };
      safeLog.log('[SystemEvents] Initialized with default state');
    }
    this.initialized = true;
  }

  /**
   * Save state to durable storage
   */
  private async saveState(): Promise<void> {
    this.state.lastSyncAt = Date.now();
    await this.ctx.storage.put('systemEventsState', this.state);
  }

  /**
   * Handle HTTP requests
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // WebSocket upgrade for real-time notifications
      if (path === '/ws' && request.headers.get('Upgrade') === 'websocket') {
        return this.handleWebSocketUpgrade(request);
      }

      // REST API endpoints
      if (request.method === 'POST') {
        const body = await request.json();
        const validated = InternalRequestSchema.parse(body);
        return await this.handleInternalRequest(validated);
      }

      if (request.method === 'GET') {
        if (path === '/state') {
          return new Response(JSON.stringify({
            success: true,
            state: this.state,
          }), {
            headers: { 'Content-Type': 'application/json' },
          });
        }

        if (path === '/queue') {
          return new Response(JSON.stringify({
            success: true,
            queue: this.state.queue,
          }), {
            headers: { 'Content-Type': 'application/json' },
          });
        }

        if (path === '/devices') {
          return new Response(JSON.stringify({
            success: true,
            devices: this.state.devices,
            mostActive: getMostActiveDevice(this.state.devices),
          }), {
            headers: { 'Content-Type': 'application/json' },
          });
        }
      }

      return new Response('Not found', { status: 404 });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Validation error',
          details: error.errors,
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      safeLog.error('[SystemEvents] Request error', {
        error: error instanceof Error ? error.message : String(error),
      });

      return new Response(JSON.stringify({
        success: false,
        error: 'Internal error',
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  /**
   * Handle internal API requests
   */
  private async handleInternalRequest(request: InternalRequest): Promise<Response> {
    switch (request.type) {
      case 'add-event':
        return await this.handleAddEvent(request.event);

      case 'get-state':
        return new Response(JSON.stringify({
          success: true,
          state: this.state,
        }), {
          headers: { 'Content-Type': 'application/json' },
        });

      case 'dismiss':
        return await this.handleDismiss(request.eventId, request.dontShowAgain);

      case 'device-activity':
        return await this.handleDeviceActivity(request);

      case 'flush-queue':
        return await this.handleFlushQueue(request.deviceId);

      default:
        return new Response(JSON.stringify({
          success: false,
          error: 'Unknown request type',
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
    }
  }

  /**
   * Generate dismissal key from event (source + type for type-based suppression)
   */
  private getDismissalKey(event: NotificationEvent): string {
    return `${event.source || 'unknown'}:${event.level}`;
  }

  /**
   * Add a notification event to the queue
   */
  private async handleAddEvent(event: NotificationEvent): Promise<Response> {
    // Check if this notification type is dismissed (by source:level key)
    const dismissalKey = this.getDismissalKey(event);
    if (this.state.dismissed.includes(dismissalKey)) {
      return new Response(JSON.stringify({
        success: true,
        queued: false,
        reason: 'dismissed',
        dismissalKey,
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // For suggestions, check throttle
    if (event.level === 'suggestion') {
      if (!canShowSuggestion(this.state.throttle)) {
        safeLog.log('[SystemEvents] Suggestion throttled', {
          sessionCount: this.state.throttle.sessionCount,
          sessionCap: this.state.throttle.sessionCap,
          lastShownAt: this.state.throttle.lastShownAt,
        });

        return new Response(JSON.stringify({
          success: true,
          queued: false,
          reason: 'throttled',
        }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    // Add to queue (suggestions are queued even when user is active, just delayed)
    this.state.queue = addEventToQueue(this.state.queue, event);

    // Track if delivery should be delayed (user is actively working)
    const isDelayed = event.level === 'suggestion' && this.state.presence.state === 'active';

    // Update throttle for suggestions (only when actually queued)
    if (event.level === 'suggestion') {
      this.state.throttle = {
        ...this.state.throttle,
        lastShownAt: Date.now(),
        sessionCount: this.state.throttle.sessionCount + 1,
      };
    }

    await this.saveState();

    safeLog.log('[SystemEvents] Event added', {
      eventId: event.id,
      level: event.level,
      title: event.title.slice(0, 50),
      delayed: isDelayed,
    });

    // Broadcast to connected WebSockets (skip if delayed suggestion)
    if (!isDelayed) {
      await this.broadcastEvent(event);
    }

    return new Response(JSON.stringify({
      success: true,
      queued: true,
      delayed: isDelayed,
      reason: isDelayed ? 'user-active' : undefined,
      queueSize: {
        critical: this.state.queue.critical.length,
        normal: this.state.queue.normal.length,
      },
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  /**
   * Dismiss a notification (and optionally suppress future ones of same type)
   */
  private async handleDismiss(
    eventId: string,
    dontShowAgain?: boolean
  ): Promise<Response> {
    // Find the event to get its dismissal key (for type-based suppression)
    const criticalEvent = this.state.queue.critical.find(e => e.id === eventId);
    const normalEvent = this.state.queue.normal.find(e => e.id === eventId);
    const event = criticalEvent || normalEvent;

    // Remove from queues (using filter for immutability)
    this.state.queue = {
      ...this.state.queue,
      critical: this.state.queue.critical.filter(e => e.id !== eventId),
      normal: this.state.queue.normal.filter(e => e.id !== eventId),
      updatedAt: Date.now(),
    };

    // Add dismissal key to dismissed list if requested (type-based suppression)
    let dismissalKey: string | undefined;
    if (dontShowAgain && event) {
      dismissalKey = this.getDismissalKey(event);
      if (!this.state.dismissed.includes(dismissalKey)) {
        this.state.dismissed = [...this.state.dismissed.slice(-99), dismissalKey]; // Keep last 100
      }
    }

    await this.saveState();

    // Broadcast dismiss to all connected devices
    await this.broadcastDismiss(eventId);

    safeLog.log('[SystemEvents] Event dismissed', {
      eventId,
      dontShowAgain,
      dismissalKey,
    });

    return new Response(JSON.stringify({
      success: true,
      dismissed: eventId,
      dismissalKey,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  /**
   * Handle device activity report (for presence tracking)
   */
  private async handleDeviceActivity(
    request: z.infer<typeof DeviceActivityRequestSchema>
  ): Promise<Response> {
    const { deviceId, deviceType, deviceName, hasActivity } = request;
    const now = Date.now();

    // Find existing device entry
    const existingIndex = this.state.devices.findIndex(d => d.deviceId === deviceId);
    const existingDevice = existingIndex >= 0 ? this.state.devices[existingIndex] : null;

    const device: DevicePresence = {
      deviceId,
      lastActivityAt: hasActivity ? now : (existingDevice?.lastActivityAt ?? now),
      isActive: hasActivity,
      deviceType: deviceType || 'unknown',
      deviceName,
    };

    // Update devices list immutably
    let newDevices: DevicePresence[];
    if (existingIndex >= 0) {
      // Replace existing device (immutable)
      newDevices = [
        ...this.state.devices.slice(0, existingIndex),
        device,
        ...this.state.devices.slice(existingIndex + 1),
      ];
    } else {
      // Add new device, but limit to 10 devices
      if (this.state.devices.length >= 10) {
        // Remove oldest inactive device (or oldest if all active)
        const inactiveIndex = this.state.devices.findIndex(d => !d.isActive);
        if (inactiveIndex >= 0) {
          // Remove inactive device, add new one (immutable)
          newDevices = [
            ...this.state.devices.slice(0, inactiveIndex),
            ...this.state.devices.slice(inactiveIndex + 1),
            device,
          ];
        } else {
          // Remove oldest (first), add new one (immutable)
          newDevices = [...this.state.devices.slice(1), device];
        }
      } else {
        // Just add new device (immutable)
        newDevices = [...this.state.devices, device];
      }
    }
    this.state.devices = newDevices;

    // Update global presence based on any device activity
    // P2 FIX: Also handle case when no active devices exist
    if (hasActivity) {
      this.state.presence = { state: 'active', lastActivityAt: now };
    } else {
      // Recalculate presence from most recent activity
      const mostActive = getMostActiveDevice(this.state.devices);
      if (mostActive) {
        this.state.presence = calculatePresenceState(mostActive.lastActivityAt);
      } else {
        // P2 FIX: No active devices - transition to away
        this.state.presence = { state: 'away', since: now };
      }
    }

    await this.saveState();

    safeLog.log('[SystemEvents] Device activity updated', {
      deviceId,
      hasActivity,
      presenceState: this.state.presence.state,
    });

    return new Response(JSON.stringify({
      success: true,
      device,
      presence: this.state.presence,
      isMostActive: getMostActiveDevice(this.state.devices)?.deviceId === deviceId,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  /**
   * Flush queue and return events for a specific device
   * P1 FIX: Track per-device delivery for critical events
   */
  private async handleFlushQueue(deviceId?: string): Promise<Response> {
    // For suggestions, only send to most active device
    const mostActive = getMostActiveDevice(this.state.devices);
    const isTargetDevice = !deviceId || mostActive?.deviceId === deviceId;

    // Critical events go to all devices
    const criticalEvents = [...this.state.queue.critical];

    // Normal events (including suggestions) only to most active device
    const normalEvents = isTargetDevice ? [...this.state.queue.normal] : [];

    // P1 FIX: Track critical event delivery per device
    if (deviceId && criticalEvents.length > 0) {
      const delivered = this.state.criticalDelivered ?? {};
      const updatedDelivered = { ...delivered };

      for (const event of criticalEvents) {
        const deviceList = updatedDelivered[event.id] ?? [];
        if (!deviceList.includes(deviceId)) {
          updatedDelivered[event.id] = [...deviceList, deviceId];
        }
      }

      this.state.criticalDelivered = updatedDelivered;
    }

    // P1 FIX: Only remove critical events when all active devices have received them
    const activeDeviceIds = this.state.devices
      .filter(d => d.isActive)
      .map(d => d.deviceId);

    const eventsToKeep = this.state.queue.critical.filter(event => {
      const deliveredTo = this.state.criticalDelivered?.[event.id] ?? [];
      // Keep event if any active device hasn't received it yet
      return activeDeviceIds.some(id => !deliveredTo.includes(id));
    });

    const eventsToRemove = this.state.queue.critical.filter(event => {
      const deliveredTo = this.state.criticalDelivered?.[event.id] ?? [];
      // Remove event if all active devices have received it
      return activeDeviceIds.every(id => deliveredTo.includes(id));
    });

    // Clean up delivery tracking for removed events
    if (eventsToRemove.length > 0 && this.state.criticalDelivered) {
      const cleanedDelivered = { ...this.state.criticalDelivered };
      for (const event of eventsToRemove) {
        delete cleanedDelivered[event.id];
      }
      this.state.criticalDelivered = cleanedDelivered;
    }

    // Clear delivered events (immutable update)
    this.state.queue = {
      ...this.state.queue,
      critical: eventsToKeep,
      normal: isTargetDevice ? [] : this.state.queue.normal,
      updatedAt: Date.now(),
    };

    await this.saveState();

    safeLog.log('[SystemEvents] Queue flushed', {
      deviceId,
      criticalCount: criticalEvents.length,
      criticalKept: eventsToKeep.length,
      criticalRemoved: eventsToRemove.length,
      normalCount: normalEvents.length,
      isTargetDevice,
    });

    return new Response(JSON.stringify({
      success: true,
      events: {
        critical: criticalEvents,
        normal: normalEvents,
      },
      isTargetDevice,
      deliveryStatus: {
        criticalDelivered: criticalEvents.length,
        criticalPendingOtherDevices: eventsToKeep.length,
      },
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  /**
   * Handle WebSocket upgrade
   * P1 FIX: Validate deviceId with Zod before accepting WebSocket
   */
  private handleWebSocketUpgrade(request: Request): Response {
    const url = new URL(request.url);
    const rawDeviceId = url.searchParams.get('deviceId');

    // P1 FIX: Validate deviceId (max 100 chars, alphanumeric + dash/underscore)
    const deviceIdSchema = z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/);
    const parseResult = deviceIdSchema.safeParse(rawDeviceId);

    const deviceId = parseResult.success
      ? parseResult.data
      : `device-${Date.now()}`; // Fallback for invalid/missing deviceId

    if (!parseResult.success && rawDeviceId) {
      safeLog.warn('[SystemEvents] Invalid deviceId rejected', {
        rawDeviceId: rawDeviceId.slice(0, 50), // Truncate for logging
        error: parseResult.error.message,
      });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server, [deviceId]);

    safeLog.log('[SystemEvents] WebSocket connected', { deviceId });

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  /**
   * Handle WebSocket messages
   */
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    try {
      if (typeof message !== 'string') return;

      const parsed = JSON.parse(message);

      // Handle device heartbeat
      if (parsed.type === 'device-heartbeat') {
        const validated = DeviceHeartbeatSchema.parse(parsed);
        const hasActivity = validated.payload.hasKeyboardActivity ||
                           validated.payload.hasMouseActivity ||
                           validated.payload.hasScrollActivity ||
                           false;

        await this.handleDeviceActivity({
          type: 'device-activity',
          deviceId: validated.payload.deviceId,
          hasActivity,
        });

        // Send presence update back
        ws.send(JSON.stringify({
          type: 'presence-update',
          payload: this.state.presence,
        }));
      }

      // Handle notification dismiss
      if (parsed.type === 'notification-dismiss') {
        const validated = NotificationDismissSchema.parse(parsed);
        await this.handleDismiss(
          validated.payload.id,
          validated.payload.dontShowAgain
        );
      }

    } catch (error) {
      safeLog.error('[SystemEvents] WebSocket message error', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Handle WebSocket close
   */
  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    const tags = this.ctx.getTags(ws);
    const deviceId = tags[0];

    if (deviceId) {
      // Mark device as inactive (immutable update)
      const deviceIndex = this.state.devices.findIndex(d => d.deviceId === deviceId);
      if (deviceIndex >= 0) {
        const device = this.state.devices[deviceIndex];
        this.state.devices = [
          ...this.state.devices.slice(0, deviceIndex),
          { ...device, isActive: false },
          ...this.state.devices.slice(deviceIndex + 1),
        ];
        await this.saveState();
      }
    }

    safeLog.log('[SystemEvents] WebSocket closed', { deviceId, code, reason });
  }

  /**
   * Broadcast event to all connected WebSockets
   */
  private async broadcastEvent(event: NotificationEvent): Promise<void> {
    const sockets = this.ctx.getWebSockets();
    const message = JSON.stringify({
      type: 'notification',
      payload: event,
    });

    // For suggestions, only send to most active device
    const mostActive = getMostActiveDevice(this.state.devices);
    const targetDeviceId = event.level === 'suggestion' ? mostActive?.deviceId : null;

    for (const ws of sockets) {
      const tags = this.ctx.getTags(ws);
      const deviceId = tags[0];

      // Skip if suggestion and not target device
      if (targetDeviceId && deviceId !== targetDeviceId) {
        continue;
      }

      try {
        ws.send(message);
      } catch {
        // Ignore send errors
      }
    }
  }

  /**
   * Broadcast dismiss to all connected WebSockets
   */
  private async broadcastDismiss(eventId: string): Promise<void> {
    const sockets = this.ctx.getWebSockets();
    const message = JSON.stringify({
      type: 'notification-dismissed',
      payload: { id: eventId },
    });

    for (const ws of sockets) {
      try {
        ws.send(message);
      } catch {
        // Ignore send errors
      }
    }
  }

  /**
   * Periodic alarm for cleanup and presence updates
   */
  async alarm(): Promise<void> {
    const now = Date.now();

    // Update presence state based on activity
    const mostActive = getMostActiveDevice(this.state.devices);
    if (mostActive) {
      this.state.presence = calculatePresenceState(mostActive.lastActivityAt);
    }

    // Clean up stale devices (no activity for 10 minutes)
    const staleThreshold = now - 600000;
    this.state.devices = this.state.devices.filter(d =>
      d.isActive || d.lastActivityAt > staleThreshold
    );

    // Reset session count if it's been more than 24 hours
    const sessionResetThreshold = now - 86400000;
    if (this.state.throttle.lastShownAt &&
        this.state.throttle.lastShownAt < sessionResetThreshold) {
      this.state.throttle.sessionCount = 0;
    }

    await this.saveState();

    safeLog.log('[SystemEvents] Alarm cleanup', {
      presenceState: this.state.presence.state,
      activeDevices: this.state.devices.filter(d => d.isActive).length,
    });

    // Schedule next alarm
    await this.ctx.storage.setAlarm(now + 300000);
  }
}
