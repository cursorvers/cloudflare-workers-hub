import { describe, expect, it } from 'vitest';

import { BUDGET_STATES } from '../../types';
import {
  consumeTokens,
  createBudgetSnapshot,
  resetBudget,
} from '../budget-controller';

describe('safety/budget-controller', () => {
  it('createBudgetSnapshot returns NORMAL with usedTokens=0', () => {
    const snapshot = createBudgetSnapshot();
    expect(snapshot.state).toBe(BUDGET_STATES.NORMAL);
    expect(snapshot.usedTokens).toBe(0);
  });

  it('consumeTokens transitions to DEGRADED at threshold', () => {
    const snapshot = createBudgetSnapshot();
    const updated = consumeTokens(snapshot, 160);
    expect(updated.state).toBe(BUDGET_STATES.DEGRADED);
    expect(updated.usageRatio).toBe(0.8);
  });

  it('consumeTokens transitions to HALTED at threshold', () => {
    const snapshot = createBudgetSnapshot();
    const updated = consumeTokens(snapshot, 190);
    expect(updated.state).toBe(BUDGET_STATES.HALTED);
    expect(updated.usageRatio).toBe(0.95);
  });

  it('HALTED is sticky (consuming 0 tokens keeps HALTED)', () => {
    const halted = consumeTokens(createBudgetSnapshot(), 200);
    const next = consumeTokens(halted, 0);
    expect(halted.state).toBe(BUDGET_STATES.HALTED);
    expect(next.state).toBe(BUDGET_STATES.HALTED);
  });

  it('resetBudget returns fresh NORMAL', () => {
    const halted = consumeTokens(createBudgetSnapshot(), 200);
    const reset = resetBudget();
    expect(halted.state).toBe(BUDGET_STATES.HALTED);
    expect(reset.state).toBe(BUDGET_STATES.NORMAL);
    expect(reset.usedTokens).toBe(0);
  });

  it('all snapshots are frozen', () => {
    const snapshot = createBudgetSnapshot();
    const consumed = consumeTokens(snapshot, 1);
    const reset = resetBudget();

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(consumed)).toBe(true);
    expect(Object.isFrozen(reset)).toBe(true);
  });

  it('usageRatio is correctly calculated', () => {
    const snapshot = createBudgetSnapshot();
    const updated = consumeTokens(snapshot, 50);
    expect(updated.usageRatio).toBe(0.25);
    expect(updated.weeklyLimit).toBe(200);
  });
});
