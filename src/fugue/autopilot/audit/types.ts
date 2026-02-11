export type AuditEventType =
  | 'POLICY_DECISION'
  | 'TOOL_EXECUTION'
  | 'BUDGET_TRANSITION'
  | 'SAFETY_EVENT'
  | 'UX_RESOLUTION';

export interface AuditEvent {
  readonly id: string;
  readonly type: AuditEventType;
  readonly traceId: string;
  readonly timestamp: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface AuditAnomaly {
  readonly type: 'REPEATED_DENIAL' | 'RAPID_ESCALATION' | 'THRASHING';
  readonly description: string;
  readonly eventIds: readonly string[];
  readonly detectedAt: string;
}
