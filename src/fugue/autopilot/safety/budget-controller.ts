import { BUDGET_STATES, DEFAULT_BUDGET_CONFIG } from '../types';
import type { BudgetConfig, BudgetSnapshot } from '../types';

function nowIso(nowMs: number = Date.now()): string {
  return new Date(nowMs).toISOString();
}

function resolveConfig(config?: BudgetConfig): BudgetConfig {
  return config ?? DEFAULT_BUDGET_CONFIG;
}

function clampUsedTokens(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function resolveState(
  usageRatio: number,
  currentState: BudgetSnapshot['state'],
  config: BudgetConfig,
): BudgetSnapshot['state'] {
  if (currentState === BUDGET_STATES.HALTED) return BUDGET_STATES.HALTED;
  if (usageRatio >= config.haltedThreshold) return BUDGET_STATES.HALTED;
  if (usageRatio >= config.degradedThreshold) return BUDGET_STATES.DEGRADED;
  return BUDGET_STATES.NORMAL;
}

function buildSnapshot(
  usedTokens: number,
  currentState: BudgetSnapshot['state'],
  config: BudgetConfig,
): BudgetSnapshot {
  const safeUsedTokens = clampUsedTokens(usedTokens);
  const usageRatio = config.weeklyLimit > 0 ? safeUsedTokens / config.weeklyLimit : 0;
  return Object.freeze({
    state: resolveState(usageRatio, currentState, config),
    usedTokens: safeUsedTokens,
    weeklyLimit: config.weeklyLimit,
    usageRatio,
    updatedAt: nowIso(),
  });
}

export function createBudgetSnapshot(config?: BudgetConfig): BudgetSnapshot {
  const resolved = resolveConfig(config);
  return buildSnapshot(0, BUDGET_STATES.NORMAL, resolved);
}

export function consumeTokens(
  snapshot: BudgetSnapshot,
  tokens: number,
  config?: BudgetConfig,
): BudgetSnapshot {
  const resolved = resolveConfig(config);
  const safeTokens = Number.isFinite(tokens) ? Math.max(0, tokens) : 0;
  return buildSnapshot(snapshot.usedTokens + safeTokens, snapshot.state, resolved);
}

export function resetBudget(config?: BudgetConfig): BudgetSnapshot {
  return createBudgetSnapshot(config);
}
