import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAuditLog, appendEvent, getEventsByTraceId, getEventsByType, type AuditLog, type AuditEvent } from '../audit';
import { MockToolExecutor, ToolCategory, type ToolRequest, type ToolResult } from '../executor';
import { DEFAULT_RULES, evaluatePolicy, type Capability, type PolicyContext, type PolicyDecision } from '../policy';
import { generateResponse, type ActionableResponse } from '../response';
import { classifyRisk } from '../risk';
import { normalizeAutopilotInput } from '../schemas/pipeline';
import {
  createSafetyState,
  detectThrashing,
  recordFailure,
  DEFAULT_SAFETY_CONFIG,
  DEFAULT_THRASHING_CONFIG,
  type SafetyState,
} from '../safety';
import {
  BUDGET_STATES,
  EFFECT_TYPES,
  ORIGINS,
  SUBJECT_TYPES,
  TRUST_ZONES,
  type BudgetState,
  type EffectType,
  type Origin,
  type RiskTier,
  type Subject,
  type TraceContext,
  type TraceId,
  type SpanId,
} from '../types';
import { resolveUxAction, type UxResponse } from '../ux';

afterEach(() => {
  vi.useRealTimers();
});

interface PipelineOptions {
  readonly traceId: string;
  readonly yaml: string;
  readonly category: ToolCategory;
  readonly effects: readonly EffectType[];
  readonly origin: Origin;
  readonly budgetState: BudgetState;
  readonly safetyState: SafetyState;
  readonly subject?: Subject;
  readonly capabilities?: readonly Capability[];
}

interface PipelineSuccessResult {
  readonly success: true;
  readonly traceId: string;
  readonly riskTier: RiskTier;
  readonly decision: PolicyDecision;
  readonly ux: UxResponse;
  readonly response: ActionableResponse;
  readonly toolResult: ToolResult | null;
  readonly auditLog: AuditLog;
}

interface PipelineFailureResult {
  readonly success: false;
  readonly traceId: string;
  readonly error: string;
  readonly auditLog: AuditLog;
}

type PipelineResult = PipelineSuccessResult | PipelineFailureResult;

function makeTraceContext(traceId: string): TraceContext {
  return Object.freeze({
    traceId: traceId as TraceId,
    spanId: `span-${traceId}` as SpanId,
    timestamp: new Date().toISOString(),
  });
}

function makeYamlTask(riskTier: RiskTier): string {
  return [
    'meta:',
    '  project: integration-suite',
    'tasks:',
    '  - id: t1',
    '    description: integration task',
    `    risk_tier: ${riskTier}`,
  ].join('\n');
}

function makeEvent(
  id: string,
  type: AuditEvent['type'],
  traceId: string,
  payload: Readonly<Record<string, unknown>>,
): AuditEvent {
  return Object.freeze({
    id,
    type,
    traceId,
    timestamp: new Date().toISOString(),
    payload,
  });
}

async function runPipeline(options: PipelineOptions): Promise<PipelineResult> {
  let auditLog = createAuditLog();
  const executor = new MockToolExecutor({ defaultLatencyMs: 0 });

  const normalized = normalizeAutopilotInput(options.yaml, options.traceId);
  auditLog = appendEvent(
    auditLog,
    makeEvent('normalize', 'SAFETY_EVENT', options.traceId, Object.freeze({ success: normalized.success })),
  );

  if (!normalized.success) {
    auditLog = appendEvent(
      auditLog,
      makeEvent('normalize-error', 'SAFETY_EVENT', options.traceId, Object.freeze({ error: normalized.error })),
    );
    return Object.freeze({
      success: false,
      traceId: options.traceId,
      error: normalized.error,
      auditLog,
    });
  }

  const task = normalized.data.tasks[0];
  if (!task) {
    throw new Error('expected at least one task in integration test fixture');
  }

  const riskTier = classifyRisk({
    effects: options.effects,
    category: options.category,
    origin: options.origin,
  });

  const traceContext = makeTraceContext(options.traceId);
  const subject = options.subject ?? Object.freeze({ id: 'user-1', type: SUBJECT_TYPES.USER });

  const policyContext: PolicyContext = Object.freeze({
    subject,
    origin: options.origin,
    effects: Object.freeze([...options.effects]),
    riskTier,
    trustZone: TRUST_ZONES.USER_INTENT,
    budgetState: options.budgetState,
    traceContext,
  });

  const decision = evaluatePolicy(policyContext, DEFAULT_RULES, options.capabilities ?? []);
  auditLog = appendEvent(
    auditLog,
    makeEvent(
      'policy',
      'POLICY_DECISION',
      options.traceId,
      Object.freeze({ allowed: decision.allowed, reason: decision.reason, riskTier }),
    ),
  );

  const ux = resolveUxAction(
    Object.freeze({
      riskTier,
      budgetState: options.budgetState,
      safetyState: options.safetyState,
      policyDecision: decision,
    }),
  );

  auditLog = appendEvent(
    auditLog,
    makeEvent('ux', 'UX_RESOLUTION', options.traceId, Object.freeze({ action: ux.action, reason: ux.reason })),
  );

  const request: ToolRequest = Object.freeze({
    id: task.id,
    category: options.category,
    name: `task:${task.id}`,
    params: Object.freeze({ description: task.description }),
    effects: Object.freeze([...options.effects]),
    riskTier,
    traceContext,
    attempt: 1,
    maxAttempts: 3,
    requestedAt: new Date().toISOString(),
    idempotencyKey: `idem-${task.id}`,
  });

  const toolResult = ux.action === 'auto-execute' ? await executor.execute(request, decision) : null;
  if (toolResult) {
    auditLog = appendEvent(
      auditLog,
      makeEvent(
        'tool',
        'TOOL_EXECUTION',
        options.traceId,
        Object.freeze({ kind: toolResult.kind, requestId: toolResult.requestId }),
      ),
    );
  }

  const response = generateResponse(ux, toolResult, options.traceId);
  auditLog = appendEvent(
    auditLog,
    makeEvent(
      'response',
      'UX_RESOLUTION',
      options.traceId,
      Object.freeze({ status: response.status, summary: response.summary }),
    ),
  );

  return Object.freeze({
    success: true,
    traceId: options.traceId,
    riskTier,
    decision,
    ux,
    response,
    toolResult,
    auditLog,
  });
}

describe('autopilot integration pipeline', () => {
  it('a. Happy path: Tier0 read-only auto-executes and returns executed response', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-11T10:00:00.000Z'));

    const result = await runPipeline({
      traceId: 'trace-happy',
      yaml: makeYamlTask(0),
      category: ToolCategory.FILE_READ,
      effects: Object.freeze([]),
      origin: ORIGINS.CLI,
      budgetState: BUDGET_STATES.NORMAL,
      safetyState: createSafetyState(),
    });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected success');

    expect(result.riskTier).toBe(0);
    expect(result.decision.allowed).toBe(true);
    expect(result.ux.action).toBe('auto-execute');
    expect(result.response.status).toBe('executed');
    expect(result.response.summary).toContain('executed');
    expect(result.toolResult?.kind).toBe('success');

    expect(Object.isFrozen(result.decision)).toBe(true);
    expect(Object.isFrozen(result.ux)).toBe(true);
    expect(Object.isFrozen(result.response)).toBe(true);
    expect(Object.isFrozen(result.auditLog)).toBe(true);
  });

  it('b. Tier3 without capability is denied with alternatives and audited', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-11T10:01:00.000Z'));

    const result = await runPipeline({
      traceId: 'trace-tier3-deny',
      yaml: makeYamlTask(3),
      category: ToolCategory.DEPLOY,
      effects: Object.freeze([EFFECT_TYPES.EXEC]),
      origin: ORIGINS.CLI,
      budgetState: BUDGET_STATES.NORMAL,
      safetyState: createSafetyState(),
    });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected success');

    expect(result.riskTier).toBe(3);
    expect(result.decision.allowed).toBe(false);
    expect(result.decision.reason).toBe('capability required');
    expect(result.response.status).toBe('denied');
    expect(result.response.alternatives.map((a) => a.description)).toContain('request a bounded capability');
    expect(getEventsByType(result.auditLog, 'POLICY_DECISION')).toHaveLength(1);
  });

  it('c. DEGRADED budget + Tier1 write is blocked and returns budget alternatives', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-11T10:02:00.000Z'));

    const result = await runPipeline({
      traceId: 'trace-budget-degraded',
      yaml: makeYamlTask(1),
      category: ToolCategory.FILE_WRITE,
      effects: Object.freeze([EFFECT_TYPES.WRITE]),
      origin: ORIGINS.CLI,
      budgetState: BUDGET_STATES.DEGRADED,
      safetyState: createSafetyState(),
    });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected success');

    expect(result.decision.allowed).toBe(false);
    expect(result.response.status).toBe('denied');
    expect(result.response.details).toContain('read-only in degraded budget state');
    expect(result.response.alternatives.map((a) => a.description)).toContain('wait for budget reset');
  });

  it('d. HALTED budget blocks all operations', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-11T10:03:00.000Z'));

    const result = await runPipeline({
      traceId: 'trace-budget-halted',
      yaml: makeYamlTask(0),
      category: ToolCategory.FILE_READ,
      effects: Object.freeze([]),
      origin: ORIGINS.CLI,
      budgetState: BUDGET_STATES.HALTED,
      safetyState: createSafetyState(),
    });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected success');

    expect(result.decision.allowed).toBe(false);
    expect(result.decision.reason).toBe('budget halted');
    expect(result.ux.action).toBe('blocked');
    expect(result.response.status).toBe('denied');
  });

  it('e. open circuit breaker blocks regardless of tier', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-11T10:04:00.000Z'));

    const result = await runPipeline({
      traceId: 'trace-circuit-open',
      yaml: makeYamlTask(0),
      category: ToolCategory.FILE_READ,
      effects: Object.freeze([]),
      origin: ORIGINS.CLI,
      budgetState: BUDGET_STATES.NORMAL,
      safetyState: Object.freeze({
        ...createSafetyState(),
        circuitBreakerOpen: true,
      }),
    });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected success');

    expect(result.decision.allowed).toBe(true);
    expect(result.ux.action).toBe('blocked');
    expect(result.ux.reason).toBe('circuit breaker is open');
    expect(result.response.status).toBe('denied');
    expect(result.response.alternatives.map((a) => a.description)).toContain('wait for recovery');
  });

  it('f. external WEBHOOK origin + Tier3 is denied by policy', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-11T10:05:00.000Z'));

    const result = await runPipeline({
      traceId: 'trace-webhook-tier3',
      yaml: makeYamlTask(3),
      category: ToolCategory.DEPLOY,
      effects: Object.freeze([EFFECT_TYPES.EXEC]),
      origin: ORIGINS.WEBHOOK,
      budgetState: BUDGET_STATES.NORMAL,
      safetyState: createSafetyState(),
      subject: Object.freeze({ id: 'ext-1', type: SUBJECT_TYPES.EXTERNAL }),
    });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected success');

    expect(result.riskTier).toBe(3);
    expect(result.decision.allowed).toBe(false);
    expect(result.decision.reason).toBe('external origin exceeds max tier (maxTier=2)');
    expect(result.response.status).toBe('denied');
  });

  it('g. invalid YAML fails pipeline early and skips policy evaluation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-11T10:06:00.000Z'));

    const result = await runPipeline({
      traceId: 'trace-invalid-yaml',
      yaml: 'meta:\n  project: demo\n  mode: [autopilot',
      category: ToolCategory.FILE_READ,
      effects: Object.freeze([]),
      origin: ORIGINS.CLI,
      budgetState: BUDGET_STATES.NORMAL,
      safetyState: createSafetyState(),
    });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');

    expect(result.error.length).toBeGreaterThan(0);
    expect(getEventsByType(result.auditLog, 'POLICY_DECISION')).toHaveLength(0);
  });

  it('h. thrashing detection flags repeated same error in safety state', () => {
    let state = createSafetyState();

    state = recordFailure(state, 'same-error', DEFAULT_SAFETY_CONFIG);
    state = recordFailure(state, 'same-error', DEFAULT_SAFETY_CONFIG);
    state = recordFailure(state, 'same-error', DEFAULT_SAFETY_CONFIG);

    const thrashing = detectThrashing(state.recentErrors, DEFAULT_THRASHING_CONFIG);

    expect(thrashing).toBe(true);
    expect(state.recentErrors.slice(-3)).toEqual(['same-error', 'same-error', 'same-error']);
    expect(state.circuitBreakerOpen).toBe(true);
  });

  it('i. full audit trail is correlated by traceId across pipeline events', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-11T10:07:00.000Z'));

    const result = await runPipeline({
      traceId: 'trace-audit-correlation',
      yaml: makeYamlTask(0),
      category: ToolCategory.FILE_READ,
      effects: Object.freeze([]),
      origin: ORIGINS.CLI,
      budgetState: BUDGET_STATES.NORMAL,
      safetyState: createSafetyState(),
    });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected success');

    const traced = getEventsByTraceId(result.auditLog, 'trace-audit-correlation');
    expect(traced.length).toBeGreaterThanOrEqual(5);
    expect(traced.every((event) => event.traceId === 'trace-audit-correlation')).toBe(true);
    expect(traced.map((event) => event.type)).toEqual(
      expect.arrayContaining(['SAFETY_EVENT', 'POLICY_DECISION', 'UX_RESOLUTION', 'TOOL_EXECUTION']),
    );
  });
});
