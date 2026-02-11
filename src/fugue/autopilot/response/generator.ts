import type { ToolResult } from '../executor/types';
import { UX_ACTIONS, type UxResponse } from '../ux/types';
import type { AlternativeAction, ActionableResponse } from './types';

const DEFAULT_TIMESTAMP = '1970-01-01T00:00:00.000Z';

function toAlternative(description: string, riskTier: UxResponse['riskTier']): AlternativeAction {
  return Object.freeze({
    description,
    riskTier,
    requiresApproval: riskTier >= 3,
  });
}

function normalizeReason(reason: string): string {
  return reason.trim().toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function extractToolName(toolResult: ToolResult | null): string {
  if (toolResult === null) return 'operation';
  if (toolResult.kind === 'success' && isRecord(toolResult.data) && typeof toolResult.data.tool === 'string') {
    return toolResult.data.tool;
  }
  return toolResult.requestId;
}

function mapPolicyAlternatives(uxResponse: UxResponse): readonly AlternativeAction[] {
  if (uxResponse.alternatives.length === 0) return Object.freeze([]);
  return Object.freeze(uxResponse.alternatives.map((item) => toAlternative(item, uxResponse.riskTier)));
}

export function generateAlternatives(uxResponse: UxResponse): readonly AlternativeAction[] {
  const reason = normalizeReason(uxResponse.reason);
  const policyAlternatives = mapPolicyAlternatives(uxResponse);
  if (reason.includes('budget')) {
    return Object.freeze([
      toAlternative('wait for budget reset', 0),
      toAlternative('request read-only operation', 0),
    ]);
  }
  if (reason.includes('tier')) {
    const lowerTier = uxResponse.riskTier <= 2 ? uxResponse.riskTier : 2;
    return Object.freeze([
      toAlternative('request with capability token', 2),
      toAlternative('break into smaller operations', lowerTier),
    ]);
  }
  if (reason.includes('circuit breaker')) {
    return Object.freeze([toAlternative('wait for recovery', 0), toAlternative('check system status', 0)]);
  }
  if (reason.includes('policy') || reason.includes('deny')) {
    if (policyAlternatives.length > 0) return policyAlternatives;
    return Object.freeze([toAlternative('request capability', 2)]);
  }
  if (policyAlternatives.length > 0) return policyAlternatives;
  return Object.freeze([toAlternative('request capability', 2)]);
}

function createResponse(
  status: ActionableResponse['status'],
  summary: string,
  details: string,
  alternatives: readonly AlternativeAction[],
  uxResponse: UxResponse,
  traceId: string,
  toolResult: ToolResult | null,
): ActionableResponse {
  return Object.freeze({
    status,
    summary,
    details,
    alternatives: Object.freeze([...alternatives]),
    riskTier: uxResponse.riskTier,
    traceId,
    timestamp: toolResult?.traceContext.timestamp ?? DEFAULT_TIMESTAMP,
  });
}

export function generateResponse(
  uxResponse: UxResponse,
  toolResult: ToolResult | null,
  traceId: string,
): ActionableResponse {
  if (uxResponse.action === UX_ACTIONS.AUTO_EXECUTE) {
    const toolName = extractToolName(toolResult);
    if (toolResult?.kind === 'success') {
      return createResponse('executed', `${toolName} executed`, `Successfully executed ${toolName}.`, [], uxResponse, traceId, toolResult);
    }
    const errorMessage = (toolResult?.kind === 'failure' || toolResult?.kind === 'timeout') ? toolResult.error : 'execution result unavailable';
    return createResponse('error', `${toolName} failed`, `Execution failed: ${errorMessage}`, [], uxResponse, traceId, toolResult);
  }
  if (uxResponse.action === UX_ACTIONS.CONFIRM_CARD) {
    return createResponse(
      'needs-input',
      'confirmation required',
      `User confirmation is required before continuing: ${uxResponse.reason}`,
      [],
      uxResponse,
      traceId,
      toolResult,
    );
  }
  if (uxResponse.action === UX_ACTIONS.HUMAN_APPROVAL) {
    return createResponse(
      'needs-input',
      'human approval required',
      `Tier 3 approval is required before execution: ${uxResponse.reason}`,
      [],
      uxResponse,
      traceId,
      toolResult,
    );
  }
  const alternatives = generateAlternatives(uxResponse);
  return createResponse(
    'denied',
    'request denied',
    `Execution denied: ${uxResponse.reason}`,
    alternatives.length > 0 ? alternatives : Object.freeze([toAlternative('request capability', 2)]),
    uxResponse,
    traceId,
    toolResult,
  );
}
