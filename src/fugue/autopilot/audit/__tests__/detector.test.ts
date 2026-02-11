import { describe, expect, it } from 'vitest';

import { createAuditLog, appendEvent, type AuditLog } from '../logger';
import type { AuditEvent } from '../types';
import { detectAnomalies } from '../detector';

function makeEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  const base: AuditEvent = {
    id: 'event-1',
    type: 'POLICY_DECISION',
    traceId: 'trace-1',
    timestamp: '2026-02-11T00:00:00.000Z',
    payload: Object.freeze({ allowed: true, riskTier: 0 }),
  };
  return Object.freeze({ ...base, ...overrides });
}

function appendAll(events: readonly AuditEvent[]): AuditLog {
  return events.reduce((log, event) => appendEvent(log, event), createAuditLog());
}

describe('audit/detector', () => {
  it('returns no anomalies for clean log', () => {
    const log = appendAll([
      makeEvent({ id: 'a', payload: Object.freeze({ allowed: true, riskTier: 1 }) }),
      makeEvent({ id: 'b', type: 'TOOL_EXECUTION', payload: Object.freeze({ status: 'success' }) }),
      makeEvent({ id: 'c', payload: Object.freeze({ allowed: true, riskTier: 1 }) }),
    ]);
    expect(detectAnomalies(log)).toEqual([]);
  });

  it('detects REPEATED_DENIAL at threshold', () => {
    const events = Array.from({ length: 5 }, (_, idx) =>
      makeEvent({
        id: `d-${idx}`,
        timestamp: `2026-02-11T00:00:0${idx}.000Z`,
        payload: Object.freeze({ allowed: false }),
      }),
    );
    const anomalies = detectAnomalies(appendAll(events));
    expect(anomalies.some((item) => item.type === 'REPEATED_DENIAL')).toBe(true);
  });

  it('does not detect REPEATED_DENIAL below threshold', () => {
    const events = Array.from({ length: 4 }, (_, idx) =>
      makeEvent({
        id: `d-${idx}`,
        timestamp: `2026-02-11T00:00:0${idx}.000Z`,
        payload: Object.freeze({ allowed: false }),
      }),
    );
    const anomalies = detectAnomalies(appendAll(events));
    expect(anomalies.some((item) => item.type === 'REPEATED_DENIAL')).toBe(false);
  });

  it('detects RAPID_ESCALATION with consecutive tier increases', () => {
    const log = appendAll([
      makeEvent({ id: 'r-0', timestamp: '2026-02-11T00:00:00.000Z', payload: Object.freeze({ riskTier: 0 }) }),
      makeEvent({ id: 'r-1', timestamp: '2026-02-11T00:00:01.000Z', payload: Object.freeze({ riskTier: 1 }) }),
      makeEvent({ id: 'r-2', timestamp: '2026-02-11T00:00:02.000Z', payload: Object.freeze({ riskTier: 2 }) }),
      makeEvent({ id: 'r-3', timestamp: '2026-02-11T00:00:03.000Z', payload: Object.freeze({ riskTier: 3 }) }),
    ]);
    const anomalies = detectAnomalies(log);
    expect(anomalies.some((item) => item.type === 'RAPID_ESCALATION')).toBe(true);
  });

  it('all anomalies are frozen', () => {
    const events = Array.from({ length: 5 }, (_, idx) =>
      makeEvent({
        id: `d-${idx}`,
        timestamp: `2026-02-11T00:00:0${idx}.000Z`,
        payload: Object.freeze({ allowed: false }),
      }),
    );
    const anomalies = detectAnomalies(appendAll(events));
    expect(Object.isFrozen(anomalies)).toBe(true);
    if (anomalies.length > 0) {
      expect(Object.isFrozen(anomalies[0])).toBe(true);
      expect(Object.isFrozen(anomalies[0]?.eventIds)).toBe(true);
    }
  });
});
