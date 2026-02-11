import type { AuditAnomaly, AuditEvent, AuditEventType } from './types';

const MAX_AUDIT_EVENTS = 1000;

export interface AuditLog {
  readonly events: readonly AuditEvent[];
  readonly anomalies: readonly AuditAnomaly[];
}

function freezeLog(events: readonly AuditEvent[], anomalies: readonly AuditAnomaly[]): AuditLog {
  return Object.freeze({
    events: Object.freeze([...events]),
    anomalies: Object.freeze([...anomalies]),
  });
}

function trimToMax(events: readonly AuditEvent[]): readonly AuditEvent[] {
  if (events.length <= MAX_AUDIT_EVENTS) return events;
  return events.slice(events.length - MAX_AUDIT_EVENTS);
}

export function createAuditLog(): AuditLog {
  return freezeLog([], []);
}

export function appendEvent(log: AuditLog, event: AuditEvent): AuditLog {
  const nextEvents = trimToMax([...log.events, event]);
  return freezeLog(nextEvents, log.anomalies);
}

export function getEventsByType(log: AuditLog, type: AuditEventType): readonly AuditEvent[] {
  return Object.freeze(log.events.filter((event) => event.type === type));
}

export function getEventsByTraceId(log: AuditLog, traceId: string): readonly AuditEvent[] {
  return Object.freeze(log.events.filter((event) => event.traceId === traceId));
}
