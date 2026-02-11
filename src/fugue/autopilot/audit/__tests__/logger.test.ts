import { describe, expect, it } from 'vitest';

import type { AuditEvent } from '../types';
import {
  appendEvent,
  createAuditLog,
  getEventsByTraceId,
  getEventsByType,
} from '../logger';

function makeEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  const base: AuditEvent = {
    id: 'event-1',
    type: 'POLICY_DECISION',
    traceId: 'trace-1',
    timestamp: '2026-02-11T00:00:00.000Z',
    payload: Object.freeze({ allowed: true }),
  };
  return Object.freeze({ ...base, ...overrides });
}

describe('audit/logger', () => {
  it('createAuditLog returns empty log', () => {
    const log = createAuditLog();
    expect(log.events).toEqual([]);
    expect(log.anomalies).toEqual([]);
  });

  it('appendEvent adds event', () => {
    const log = createAuditLog();
    const next = appendEvent(log, makeEvent());
    expect(next.events).toHaveLength(1);
    expect(next.events[0]?.id).toBe('event-1');
  });

  it('appendEvent keeps max 1000 events', () => {
    let log = createAuditLog();
    for (let i = 0; i < 1005; i += 1) {
      log = appendEvent(log, makeEvent({ id: `event-${i}` }));
    }
    expect(log.events).toHaveLength(1000);
    expect(log.events[0]?.id).toBe('event-5');
    expect(log.events[999]?.id).toBe('event-1004');
  });

  it('getEventsByType filters events', () => {
    const base = createAuditLog();
    const log = appendEvent(
      appendEvent(base, makeEvent({ id: 'a', type: 'POLICY_DECISION' })),
      makeEvent({ id: 'b', type: 'TOOL_EXECUTION' }),
    );
    const filtered = getEventsByType(log, 'POLICY_DECISION');
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.id).toBe('a');
  });

  it('getEventsByTraceId filters events', () => {
    const base = createAuditLog();
    const log = appendEvent(
      appendEvent(base, makeEvent({ id: 'a', traceId: 'trace-a' })),
      makeEvent({ id: 'b', traceId: 'trace-b' }),
    );
    const filtered = getEventsByTraceId(log, 'trace-b');
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.id).toBe('b');
  });

  it('all logger outputs are frozen', () => {
    const log = createAuditLog();
    const next = appendEvent(log, makeEvent());
    const byType = getEventsByType(next, 'POLICY_DECISION');
    const byTrace = getEventsByTraceId(next, 'trace-1');

    expect(Object.isFrozen(log)).toBe(true);
    expect(Object.isFrozen(log.events)).toBe(true);
    expect(Object.isFrozen(log.anomalies)).toBe(true);
    expect(Object.isFrozen(next)).toBe(true);
    expect(Object.isFrozen(next.events)).toBe(true);
    expect(Object.isFrozen(byType)).toBe(true);
    expect(Object.isFrozen(byTrace)).toBe(true);
  });
});
