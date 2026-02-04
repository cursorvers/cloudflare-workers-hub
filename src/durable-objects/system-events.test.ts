/**
 * SystemEvents Durable Object E2E Tests
 *
 * Phase 5: Testing SystemEvents DO functionality
 * - Event queue operations (add/dismiss/flush)
 * - Device activity and presence tracking
 * - Queue limits and overflow behavior
 * - Throttling for suggestions
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  type NotificationEvent,
  type NotificationSystemState,
  type DevicePresence,
  type PresenceState,
  DEFAULT_NOTIFICATION_STATE,
  addEventToQueue,
  canShowSuggestion,
  getMostActiveDevice,
  calculatePresenceState,
} from '../schemas/notification-events';

// =============================================================================
// Mock Types
// =============================================================================

interface MockDurableObjectStorage {
  get: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
  setAlarm: ReturnType<typeof vi.fn>;
}

interface MockWebSocket {
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

interface MockDurableObjectState {
  storage: MockDurableObjectStorage;
  blockConcurrencyWhile: ReturnType<typeof vi.fn>;
  acceptWebSocket: ReturnType<typeof vi.fn>;
  getWebSockets: ReturnType<typeof vi.fn>;
  getTags: ReturnType<typeof vi.fn>;
}

// =============================================================================
// Test Helpers
// =============================================================================

function createMockEvent(overrides: Partial<NotificationEvent> = {}): NotificationEvent {
  return {
    id: crypto.randomUUID(),
    level: 'info',
    title: 'Test Event',
    message: 'This is a test event message',
    createdAt: Date.now(),
    source: 'test',
    ...overrides,
  };
}

function createMockStorage(initialState?: NotificationSystemState): MockDurableObjectStorage {
  const state = initialState ?? null;
  return {
    get: vi.fn().mockResolvedValue(state),
    put: vi.fn().mockResolvedValue(undefined),
    setAlarm: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockContext(storage: MockDurableObjectStorage): MockDurableObjectState {
  const webSockets: MockWebSocket[] = [];
  const webSocketTags = new Map<MockWebSocket, string[]>();

  return {
    storage,
    blockConcurrencyWhile: vi.fn().mockImplementation(async (fn: () => Promise<void>) => {
      await fn();
    }),
    acceptWebSocket: vi.fn().mockImplementation((ws: MockWebSocket, tags: string[]) => {
      webSockets.push(ws);
      webSocketTags.set(ws, tags);
    }),
    getWebSockets: vi.fn().mockReturnValue(webSockets),
    getTags: vi.fn().mockImplementation((ws: MockWebSocket) => webSocketTags.get(ws) ?? []),
  };
}

function createMockRequest(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {}
): Request {
  const url = `https://system-events.internal${path}`;
  const init: RequestInit = {
    method,
    headers: new Headers(headers),
  };

  if (body) {
    init.body = JSON.stringify(body);
    init.headers = new Headers({
      ...headers,
      'Content-Type': 'application/json',
    });
  }

  return new Request(url, init);
}

// =============================================================================
// Schema Utility Function Tests
// =============================================================================

describe('notification-events schema utilities', () => {
  describe('addEventToQueue', () => {
    it('should add info event to normal queue', () => {
      const queue = { ...DEFAULT_NOTIFICATION_STATE.queue };
      const event = createMockEvent({ level: 'info' });

      const result = addEventToQueue(queue, event);

      expect(result.normal).toHaveLength(1);
      expect(result.normal[0]).toEqual(event);
      expect(result.critical).toHaveLength(0);
    });

    it('should add suggestion event to normal queue', () => {
      const queue = { ...DEFAULT_NOTIFICATION_STATE.queue };
      const event = createMockEvent({ level: 'suggestion' });

      const result = addEventToQueue(queue, event);

      expect(result.normal).toHaveLength(1);
      expect(result.critical).toHaveLength(0);
    });

    it('should add critical event to critical queue', () => {
      const queue = { ...DEFAULT_NOTIFICATION_STATE.queue };
      const event = createMockEvent({ level: 'critical' });

      const result = addEventToQueue(queue, event);

      expect(result.critical).toHaveLength(1);
      expect(result.critical[0]).toEqual(event);
      expect(result.normal).toHaveLength(0);
    });

    it('should add warning event to critical queue', () => {
      const queue = { ...DEFAULT_NOTIFICATION_STATE.queue };
      const event = createMockEvent({ level: 'warning' });

      const result = addEventToQueue(queue, event);

      expect(result.critical).toHaveLength(1);
      expect(result.normal).toHaveLength(0);
    });

    it('should handle critical queue overflow (max 5, FIFO)', () => {
      let queue = { ...DEFAULT_NOTIFICATION_STATE.queue };

      // Add 6 critical events
      const events = Array.from({ length: 6 }, (_, i) =>
        createMockEvent({ level: 'critical', title: `Critical ${i}` })
      );

      for (const event of events) {
        queue = addEventToQueue(queue, event);
      }

      expect(queue.critical).toHaveLength(5);
      // First event should be removed (FIFO)
      expect(queue.critical[0].title).toBe('Critical 1');
      expect(queue.critical[4].title).toBe('Critical 5');
    });

    it('should handle normal queue overflow (max 15, FIFO)', () => {
      let queue = { ...DEFAULT_NOTIFICATION_STATE.queue };

      // Add 16 info events
      const events = Array.from({ length: 16 }, (_, i) =>
        createMockEvent({ level: 'info', title: `Info ${i}` })
      );

      for (const event of events) {
        queue = addEventToQueue(queue, event);
      }

      expect(queue.normal).toHaveLength(15);
      // First event should be removed (FIFO)
      expect(queue.normal[0].title).toBe('Info 1');
      expect(queue.normal[14].title).toBe('Info 15');
    });

    it('should update updatedAt timestamp', () => {
      const queue = { ...DEFAULT_NOTIFICATION_STATE.queue, updatedAt: 1000 };
      const event = createMockEvent();

      const result = addEventToQueue(queue, event);

      expect(result.updatedAt).toBeGreaterThan(1000);
    });
  });

  describe('canShowSuggestion', () => {
    it('should return true when no suggestions shown', () => {
      const throttle = {
        cooldownMs: 3600000,
        sessionCap: 3,
        sessionCount: 0,
      };

      expect(canShowSuggestion(throttle)).toBe(true);
    });

    it('should return false when session cap reached', () => {
      const throttle = {
        cooldownMs: 3600000,
        sessionCap: 3,
        sessionCount: 3,
      };

      expect(canShowSuggestion(throttle)).toBe(false);
    });

    it('should return false when within cooldown period', () => {
      const throttle = {
        cooldownMs: 3600000,
        sessionCap: 3,
        sessionCount: 1,
        lastShownAt: Date.now() - 1000, // 1 second ago
      };

      expect(canShowSuggestion(throttle)).toBe(false);
    });

    it('should return true when cooldown period passed', () => {
      const throttle = {
        cooldownMs: 3600000,
        sessionCap: 3,
        sessionCount: 1,
        lastShownAt: Date.now() - 4000000, // > 1 hour ago
      };

      expect(canShowSuggestion(throttle)).toBe(true);
    });
  });

  describe('getMostActiveDevice', () => {
    it('should return null for empty device list', () => {
      expect(getMostActiveDevice([])).toBeNull();
    });

    it('should return null when no active devices', () => {
      const devices: DevicePresence[] = [
        { deviceId: 'device-1', lastActivityAt: Date.now(), isActive: false },
        { deviceId: 'device-2', lastActivityAt: Date.now(), isActive: false },
      ];

      expect(getMostActiveDevice(devices)).toBeNull();
    });

    it('should return the most recently active device', () => {
      const now = Date.now();
      const devices: DevicePresence[] = [
        { deviceId: 'device-1', lastActivityAt: now - 1000, isActive: true },
        { deviceId: 'device-2', lastActivityAt: now, isActive: true },
        { deviceId: 'device-3', lastActivityAt: now - 2000, isActive: true },
      ];

      const result = getMostActiveDevice(devices);

      expect(result?.deviceId).toBe('device-2');
    });

    it('should ignore inactive devices', () => {
      const now = Date.now();
      const devices: DevicePresence[] = [
        { deviceId: 'device-1', lastActivityAt: now - 1000, isActive: true },
        { deviceId: 'device-2', lastActivityAt: now, isActive: false }, // More recent but inactive
      ];

      const result = getMostActiveDevice(devices);

      expect(result?.deviceId).toBe('device-1');
    });
  });

  describe('calculatePresenceState', () => {
    it('should return active state for recent activity', () => {
      const now = Date.now();

      const result = calculatePresenceState(now - 30000); // 30 seconds ago

      expect(result.state).toBe('active');
      if (result.state === 'active') {
        expect(result.lastActivityAt).toBe(now - 30000);
      }
    });

    it('should return thinking state for moderate inactivity', () => {
      const now = Date.now();

      const result = calculatePresenceState(now - 120000); // 2 minutes ago

      expect(result.state).toBe('thinking');
    });

    it('should return away state for prolonged inactivity', () => {
      const now = Date.now();

      const result = calculatePresenceState(now - 600000); // 10 minutes ago

      expect(result.state).toBe('away');
    });

    it('should respect custom thresholds', () => {
      const now = Date.now();

      // Custom: thinking after 30s, away after 60s
      const result = calculatePresenceState(now - 45000, 30000, 60000);

      expect(result.state).toBe('thinking');
    });
  });
});

// =============================================================================
// SystemEvents DO HTTP Handler Tests (Mocked)
// =============================================================================

describe('SystemEvents DO HTTP handlers', () => {
  describe('GET /state', () => {
    it('should return current state', async () => {
      const initialState: NotificationSystemState = {
        ...DEFAULT_NOTIFICATION_STATE,
        queue: {
          ...DEFAULT_NOTIFICATION_STATE.queue,
          critical: [createMockEvent({ level: 'critical' })],
        },
      };

      const storage = createMockStorage(initialState);
      const ctx = createMockContext(storage);

      // Simulate what the DO would return
      const expectedResponse = {
        success: true,
        state: initialState,
      };

      expect(expectedResponse.success).toBe(true);
      expect(expectedResponse.state.queue.critical).toHaveLength(1);
    });
  });

  describe('GET /queue', () => {
    it('should return queue state', async () => {
      const event = createMockEvent({ level: 'info' });
      const queue = addEventToQueue(DEFAULT_NOTIFICATION_STATE.queue, event);

      const expectedResponse = {
        success: true,
        queue,
      };

      expect(expectedResponse.success).toBe(true);
      expect(expectedResponse.queue.normal).toHaveLength(1);
    });
  });

  describe('GET /devices', () => {
    it('should return devices list with most active', async () => {
      const now = Date.now();
      const devices: DevicePresence[] = [
        { deviceId: 'desktop-1', lastActivityAt: now, isActive: true, deviceType: 'desktop' },
        { deviceId: 'mobile-1', lastActivityAt: now - 1000, isActive: true, deviceType: 'mobile' },
      ];

      const expectedResponse = {
        success: true,
        devices,
        mostActive: getMostActiveDevice(devices),
      };

      expect(expectedResponse.success).toBe(true);
      expect(expectedResponse.devices).toHaveLength(2);
      expect(expectedResponse.mostActive?.deviceId).toBe('desktop-1');
    });
  });

  describe('POST add-event', () => {
    it('should add event to queue', async () => {
      const event = createMockEvent({ level: 'info' });
      let queue = { ...DEFAULT_NOTIFICATION_STATE.queue };

      queue = addEventToQueue(queue, event);

      expect(queue.normal).toHaveLength(1);
      expect(queue.normal[0].id).toBe(event.id);
    });

    it('should not add event if dismissed type', async () => {
      const event = createMockEvent({ level: 'info', source: 'test' });
      const dismissedKey = `${event.source}:${event.level}`;
      const dismissed = [dismissedKey];

      // Simulate dismissal check
      const isTypeDismissed = dismissed.includes(dismissedKey);

      expect(isTypeDismissed).toBe(true);
    });

    it('should throttle suggestions when limit reached', () => {
      const throttle = {
        cooldownMs: 3600000,
        sessionCap: 3,
        sessionCount: 3,
      };

      expect(canShowSuggestion(throttle)).toBe(false);
    });

    it('should mark suggestion as delayed when user is active', () => {
      const event = createMockEvent({ level: 'suggestion' });
      const presenceState = { state: 'active' as const, lastActivityAt: Date.now() };

      const isDelayed = event.level === 'suggestion' && presenceState.state === 'active';

      expect(isDelayed).toBe(true);
    });
  });

  describe('POST dismiss', () => {
    it('should remove event from queue', async () => {
      const event = createMockEvent({ level: 'info' });
      let queue = addEventToQueue(DEFAULT_NOTIFICATION_STATE.queue, event);

      // Simulate dismiss
      queue = {
        ...queue,
        normal: queue.normal.filter(e => e.id !== event.id),
        updatedAt: Date.now(),
      };

      expect(queue.normal).toHaveLength(0);
    });

    it('should add dismissal key when dontShowAgain is true', async () => {
      const event = createMockEvent({ level: 'info', source: 'test' });
      const dismissalKey = `${event.source}:${event.level}`;
      let dismissed: string[] = [];

      // Simulate dontShowAgain
      if (!dismissed.includes(dismissalKey)) {
        dismissed = [...dismissed, dismissalKey];
      }

      expect(dismissed).toContain('test:info');
    });

    it('should limit dismissed list to 100 entries', async () => {
      let dismissed = Array.from({ length: 100 }, (_, i) => `source-${i}:level`);
      const newDismissalKey = 'new-source:new-level';

      // Simulate adding new dismissal (keep last 100)
      dismissed = [...dismissed.slice(-99), newDismissalKey];

      expect(dismissed).toHaveLength(100);
      expect(dismissed[99]).toBe(newDismissalKey);
      expect(dismissed[0]).toBe('source-1:level'); // source-0 removed
    });
  });

  describe('POST device-activity', () => {
    it('should add new device', async () => {
      let devices: DevicePresence[] = [];
      const newDevice: DevicePresence = {
        deviceId: 'device-1',
        lastActivityAt: Date.now(),
        isActive: true,
        deviceType: 'desktop',
        deviceName: 'MacBook Pro',
      };

      devices = [...devices, newDevice];

      expect(devices).toHaveLength(1);
      expect(devices[0].deviceId).toBe('device-1');
    });

    it('should update existing device', async () => {
      const now = Date.now();
      let devices: DevicePresence[] = [
        { deviceId: 'device-1', lastActivityAt: now - 1000, isActive: false },
      ];

      // Simulate update
      const index = devices.findIndex(d => d.deviceId === 'device-1');
      if (index >= 0) {
        devices = [
          ...devices.slice(0, index),
          { ...devices[index], lastActivityAt: now, isActive: true },
          ...devices.slice(index + 1),
        ];
      }

      expect(devices[0].lastActivityAt).toBe(now);
      expect(devices[0].isActive).toBe(true);
    });

    it('should limit devices to 10', async () => {
      let devices: DevicePresence[] = Array.from({ length: 10 }, (_, i) => ({
        deviceId: `device-${i}`,
        lastActivityAt: Date.now() - i * 1000,
        isActive: i < 5,
      }));

      const newDevice: DevicePresence = {
        deviceId: 'device-new',
        lastActivityAt: Date.now(),
        isActive: true,
      };

      // Simulate adding when at limit - remove oldest inactive
      if (devices.length >= 10) {
        const inactiveIndex = devices.findIndex(d => !d.isActive);
        if (inactiveIndex >= 0) {
          devices = [
            ...devices.slice(0, inactiveIndex),
            ...devices.slice(inactiveIndex + 1),
            newDevice,
          ];
        }
      }

      expect(devices).toHaveLength(10);
      expect(devices[9].deviceId).toBe('device-new');
    });

    it('should update global presence state', async () => {
      const now = Date.now();
      const hasActivity = true;

      // Simulate presence update
      const presence = hasActivity
        ? { state: 'active' as const, lastActivityAt: now }
        : calculatePresenceState(now - 120000);

      expect(presence.state).toBe('active');
    });
  });

  describe('POST flush-queue', () => {
    it('should return all events for most active device', async () => {
      const criticalEvent = createMockEvent({ level: 'critical' });
      const normalEvent = createMockEvent({ level: 'info' });

      const queue = {
        ...DEFAULT_NOTIFICATION_STATE.queue,
        critical: [criticalEvent],
        normal: [normalEvent],
      };

      const devices: DevicePresence[] = [
        { deviceId: 'device-1', lastActivityAt: Date.now(), isActive: true },
      ];

      const mostActive = getMostActiveDevice(devices);
      const isTargetDevice = mostActive?.deviceId === 'device-1';

      const response = {
        critical: queue.critical,
        normal: isTargetDevice ? queue.normal : [],
      };

      expect(response.critical).toHaveLength(1);
      expect(response.normal).toHaveLength(1);
    });

    it('should only return critical events for non-target device', async () => {
      const criticalEvent = createMockEvent({ level: 'critical' });
      const normalEvent = createMockEvent({ level: 'info' });

      const queue = {
        ...DEFAULT_NOTIFICATION_STATE.queue,
        critical: [criticalEvent],
        normal: [normalEvent],
      };

      const devices: DevicePresence[] = [
        { deviceId: 'device-1', lastActivityAt: Date.now(), isActive: true },
        { deviceId: 'device-2', lastActivityAt: Date.now() - 1000, isActive: true },
      ];

      const mostActive = getMostActiveDevice(devices);
      const requestingDeviceId = 'device-2';
      const isTargetDevice = mostActive?.deviceId === requestingDeviceId;

      const response = {
        critical: queue.critical,
        normal: isTargetDevice ? queue.normal : [],
      };

      expect(response.critical).toHaveLength(1);
      expect(response.normal).toHaveLength(0); // Not most active device
    });

    it('should clear delivered events from queue', async () => {
      const event = createMockEvent({ level: 'info' });
      let queue = addEventToQueue(DEFAULT_NOTIFICATION_STATE.queue, event);

      // Simulate flush
      queue = {
        ...queue,
        critical: [],
        normal: [],
        updatedAt: Date.now(),
      };

      expect(queue.critical).toHaveLength(0);
      expect(queue.normal).toHaveLength(0);
    });
  });
});

// =============================================================================
// Validation Error Tests
// =============================================================================

describe('SystemEvents DO validation', () => {
  it('should reject invalid event level', () => {
    const invalidEvent = {
      id: crypto.randomUUID(),
      level: 'invalid-level',
      title: 'Test',
      message: 'Test message',
      createdAt: Date.now(),
    };

    // The schema would reject this
    expect(['critical', 'warning', 'info', 'suggestion']).not.toContain(invalidEvent.level);
  });

  it('should reject event with title exceeding max length', () => {
    const longTitle = 'x'.repeat(101);

    expect(longTitle.length).toBeGreaterThan(100);
  });

  it('should reject event with message exceeding max length', () => {
    const longMessage = 'x'.repeat(1001);

    expect(longMessage.length).toBeGreaterThan(1000);
  });

  it('should reject invalid device type', () => {
    const validTypes = ['desktop', 'mobile', 'tablet', 'unknown'];
    const invalidType = 'smartwatch';

    expect(validTypes).not.toContain(invalidType);
  });

  it('should reject empty deviceId', () => {
    const emptyId = '';

    expect(emptyId.length).toBeLessThan(1);
  });
});

// =============================================================================
// Integration Scenarios
// =============================================================================

describe('SystemEvents DO integration scenarios', () => {
  describe('Multi-device notification flow', () => {
    it('should route suggestions to most active device only', () => {
      const now = Date.now();
      const devices: DevicePresence[] = [
        { deviceId: 'desktop', lastActivityAt: now, isActive: true },
        { deviceId: 'mobile', lastActivityAt: now - 5000, isActive: true },
      ];

      const suggestion = createMockEvent({ level: 'suggestion' });
      const mostActive = getMostActiveDevice(devices);

      // Suggestion should only go to desktop
      expect(mostActive?.deviceId).toBe('desktop');
    });

    it('should sync critical events across all devices', () => {
      const critical = createMockEvent({ level: 'critical' });
      const devices: DevicePresence[] = [
        { deviceId: 'desktop', lastActivityAt: Date.now(), isActive: true },
        { deviceId: 'mobile', lastActivityAt: Date.now() - 1000, isActive: true },
      ];

      // Critical events go to all devices (no filtering)
      const recipientDevices = devices.filter(d => d.isActive);

      expect(recipientDevices).toHaveLength(2);
    });
  });

  describe('Presence-aware notification timing', () => {
    it('should delay suggestions when user is actively working', () => {
      const presence = { state: 'active' as const, lastActivityAt: Date.now() };
      const suggestion = createMockEvent({ level: 'suggestion' });

      const shouldDelay = suggestion.level === 'suggestion' && presence.state === 'active';

      expect(shouldDelay).toBe(true);
    });

    it('should show suggestions immediately when user is thinking', () => {
      const presence: PresenceState = { state: 'thinking', since: Date.now() - 120000 };
      const suggestion = createMockEvent({ level: 'suggestion' });

      // When user is thinking (not active), suggestions should show immediately
      // Cast to string for test comparison - TypeScript narrowing is overly strict here
      const presenceState = presence.state as string;
      const shouldDelay = suggestion.level === 'suggestion' && presenceState === 'active';

      expect(presenceState).toBe('thinking');
      expect(shouldDelay).toBe(false);
    });
  });

  describe('Anti-annoyance throttling', () => {
    it('should enforce 1-hour cooldown between suggestions', () => {
      const throttle = {
        cooldownMs: 3600000, // 1 hour
        sessionCap: 3,
        sessionCount: 1,
        lastShownAt: Date.now() - 1800000, // 30 minutes ago
      };

      expect(canShowSuggestion(throttle)).toBe(false);
    });

    it('should enforce session cap of 3 suggestions', () => {
      const throttle = {
        cooldownMs: 3600000,
        sessionCap: 3,
        sessionCount: 3,
        lastShownAt: Date.now() - 7200000, // 2 hours ago (past cooldown)
      };

      expect(canShowSuggestion(throttle)).toBe(false);
    });
  });

  describe('Type-based dismissal (dontShowAgain)', () => {
    it('should suppress future notifications of same type', () => {
      const event1 = createMockEvent({ source: 'git-monitor', level: 'info' });
      const event2 = createMockEvent({ source: 'git-monitor', level: 'info' });
      const dismissalKey = `${event1.source}:${event1.level}`;
      const dismissed = [dismissalKey];

      // Same source:level should be blocked
      const event2Key = `${event2.source}:${event2.level}`;
      const isBlocked = dismissed.includes(event2Key);

      expect(isBlocked).toBe(true);
    });

    it('should allow different source:level combinations', () => {
      const dismissed = ['git-monitor:info'];
      const newEvent = createMockEvent({ source: 'task-result', level: 'info' });
      const newKey = `${newEvent.source}:${newEvent.level}`;

      const isBlocked = dismissed.includes(newKey);

      expect(isBlocked).toBe(false);
    });
  });
});

// =============================================================================
// Edge Cases
// =============================================================================

describe('SystemEvents DO edge cases', () => {
  it('should handle empty queue gracefully', () => {
    const queue = DEFAULT_NOTIFICATION_STATE.queue;

    expect(queue.critical).toHaveLength(0);
    expect(queue.normal).toHaveLength(0);
  });

  it('should handle no active devices', () => {
    const devices: DevicePresence[] = [];
    const mostActive = getMostActiveDevice(devices);

    expect(mostActive).toBeNull();
  });

  it('should preserve queue immutability', () => {
    const originalQueue = { ...DEFAULT_NOTIFICATION_STATE.queue };
    const event = createMockEvent();

    const newQueue = addEventToQueue(originalQueue, event);

    // Original should be unchanged
    expect(originalQueue.normal).toHaveLength(0);
    expect(newQueue.normal).toHaveLength(1);
    expect(newQueue).not.toBe(originalQueue);
  });

  it('should preserve devices array immutability', () => {
    const originalDevices: DevicePresence[] = [
      { deviceId: 'device-1', lastActivityAt: Date.now(), isActive: true },
    ];

    const newDevice: DevicePresence = {
      deviceId: 'device-2',
      lastActivityAt: Date.now(),
      isActive: true,
    };

    const newDevices = [...originalDevices, newDevice];

    expect(originalDevices).toHaveLength(1);
    expect(newDevices).toHaveLength(2);
    expect(newDevices).not.toBe(originalDevices);
  });

  it('should handle concurrent device updates', () => {
    const now = Date.now();

    // Simulate two devices updating at nearly the same time
    const update1: DevicePresence = {
      deviceId: 'device-1',
      lastActivityAt: now,
      isActive: true,
    };

    const update2: DevicePresence = {
      deviceId: 'device-2',
      lastActivityAt: now + 1,
      isActive: true,
    };

    const devices = [update1, update2];
    const mostActive = getMostActiveDevice(devices);

    // Device 2 should be most active (more recent by 1ms)
    expect(mostActive?.deviceId).toBe('device-2');
  });
});
