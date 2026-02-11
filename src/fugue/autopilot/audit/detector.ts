import type { AuditAnomaly, AuditEvent } from './types';
import type { AuditLog } from './logger';

export interface AnomalyConfig {
  readonly denialThreshold: number;
  readonly windowMs: number;
  readonly escalationSteps: number;
}

export const DEFAULT_ANOMALY_CONFIG: AnomalyConfig = Object.freeze({
  denialThreshold: 5,
  windowMs: 60_000,
  escalationSteps: 3,
});

function toEpochMs(timestamp: string): number | null {
  const value = Date.parse(timestamp);
  return Number.isNaN(value) ? null : value;
}

function isWithinWindow(start: number, end: number, windowMs: number): boolean {
  return end - start <= windowMs;
}

function isDeniedPolicyEvent(event: AuditEvent): boolean {
  return event.type === 'POLICY_DECISION' && event.payload.allowed === false;
}

function asTier(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function extractRiskTier(event: AuditEvent): number | null {
  const direct = asTier(event.payload.riskTier);
  if (direct !== null) return direct;
  const tier = asTier(event.payload.toRiskTier);
  if (tier !== null) return tier;
  return asTier(event.payload.toTier);
}

function sortByTimestamp(events: readonly AuditEvent[]): readonly AuditEvent[] {
  return [...events].sort((left, right) => {
    const leftTime = toEpochMs(left.timestamp) ?? Number.POSITIVE_INFINITY;
    const rightTime = toEpochMs(right.timestamp) ?? Number.POSITIVE_INFINITY;
    return leftTime - rightTime;
  });
}

function freezeAnomaly(
  type: AuditAnomaly['type'],
  description: string,
  eventIds: readonly string[],
  detectedAt: string,
): AuditAnomaly {
  return Object.freeze({
    type,
    description,
    eventIds: Object.freeze([...eventIds]),
    detectedAt,
  });
}

function detectRepeatedDenials(events: readonly AuditEvent[], config: AnomalyConfig): readonly AuditAnomaly[] {
  const denied = sortByTimestamp(events.filter(isDeniedPolicyEvent));
  if (denied.length < config.denialThreshold) return Object.freeze([]);

  const anomalies: AuditAnomaly[] = [];
  let start = 0;

  for (let end = 0; end < denied.length; end += 1) {
    const endTime = toEpochMs(denied[end].timestamp);
    if (endTime === null) continue;
    while (start < end) {
      const startTime = toEpochMs(denied[start].timestamp);
      if (startTime === null || !isWithinWindow(startTime, endTime, config.windowMs)) start += 1;
      else break;
    }
    const count = end - start + 1;
    if (count < config.denialThreshold) continue;
    const windowEvents = denied.slice(start, end + 1);
    anomalies.push(
      freezeAnomaly(
        'REPEATED_DENIAL',
        `${count} denied policy decisions within ${config.windowMs}ms`,
        windowEvents.map((event) => event.id),
        denied[end].timestamp,
      ),
    );
    start = end + 1;
  }

  return Object.freeze(anomalies);
}

function detectRapidEscalation(events: readonly AuditEvent[], config: AnomalyConfig): readonly AuditAnomaly[] {
  const ordered = sortByTimestamp(events);
  const anomalies: AuditAnomaly[] = [];
  let chainEvents: AuditEvent[] = [];
  let increases = 0;

  for (const event of ordered) {
    const tier = extractRiskTier(event);
    if (tier === null) continue;
    if (chainEvents.length === 0) {
      chainEvents = [event];
      increases = 0;
      continue;
    }

    const previousEvent = chainEvents[chainEvents.length - 1];
    const previousTier = extractRiskTier(previousEvent);
    const startTime = toEpochMs(chainEvents[0].timestamp);
    const currentTime = toEpochMs(event.timestamp);
    if (previousTier === null || startTime === null || currentTime === null || !isWithinWindow(startTime, currentTime, config.windowMs)) {
      chainEvents = [event];
      increases = 0;
      continue;
    }

    if (tier > previousTier) increases += 1;
    else increases = 0;
    chainEvents.push(event);

    if (increases < config.escalationSteps) continue;
    const eventIds = chainEvents.slice(chainEvents.length - (config.escalationSteps + 1)).map((item) => item.id);
    anomalies.push(
      freezeAnomaly(
        'RAPID_ESCALATION',
        `${config.escalationSteps} consecutive risk tier increases within ${config.windowMs}ms`,
        eventIds,
        event.timestamp,
      ),
    );
    chainEvents = [event];
    increases = 0;
  }

  return Object.freeze(anomalies);
}

function resolveConfig(config?: AnomalyConfig): AnomalyConfig {
  if (!config) return DEFAULT_ANOMALY_CONFIG;
  return Object.freeze({
    denialThreshold: config.denialThreshold,
    windowMs: config.windowMs,
    escalationSteps: config.escalationSteps,
  });
}

export function detectAnomalies(log: AuditLog, config?: AnomalyConfig): readonly AuditAnomaly[] {
  const resolved = resolveConfig(config);
  const repeatedDenials = detectRepeatedDenials(log.events, resolved);
  const rapidEscalation = detectRapidEscalation(log.events, resolved);
  return Object.freeze([...repeatedDenials, ...rapidEscalation]);
}
