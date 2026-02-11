import { describe, expect, it } from 'vitest';

import {
  applyTransition,
  createInitialState,
  isOperational,
  transitionMode,
} from '../coordinator';

describe('runtime/coordinator', () => {
  it('初期状態がSTOPPED', () => {
    const state = createInitialState();
    expect(state.mode).toBe('STOPPED');
    expect(state.lastTransition).toBeNull();
    expect(state.transitionCount).toBe(0);
  });

  it('STOPPED→NORMAL遷移成功', () => {
    const state = createInitialState();
    const result = transitionMode(state, 'NORMAL', 'resume', 1000);
    const next = applyTransition(state, result);

    expect(result.success).toBe(true);
    expect(result.previousMode).toBe('STOPPED');
    expect(result.currentMode).toBe('NORMAL');
    expect(next.mode).toBe('NORMAL');
  });

  it('NORMAL→STOPPED遷移成功', () => {
    const stopped = createInitialState();
    const toNormal = transitionMode(stopped, 'NORMAL', 'resume', 1000);
    const normal = applyTransition(stopped, toNormal);

    const toStopped = transitionMode(normal, 'STOPPED', 'manual-stop', 2000);
    const next = applyTransition(normal, toStopped);

    expect(toStopped.success).toBe(true);
    expect(toStopped.previousMode).toBe('NORMAL');
    expect(toStopped.currentMode).toBe('STOPPED');
    expect(next.mode).toBe('STOPPED');
  });

  it('同じモードへの遷移（冪等: 成功扱い）', () => {
    const state = createInitialState();
    const result = transitionMode(state, 'STOPPED', 'already stopped', 3000);
    const next = applyTransition(state, result);

    expect(result.success).toBe(true);
    expect(result.previousMode).toBe('STOPPED');
    expect(result.currentMode).toBe('STOPPED');
    expect(result.reason).toContain('idempotent no-op');
    expect(next.mode).toBe('STOPPED');
  });

  it('遷移結果にtimestamp含む', () => {
    const state = createInitialState();
    const result = transitionMode(state, 'NORMAL', 'resume', 123456789);
    expect(result.timestamp).toBe(123456789);
  });

  it('applyTransitionで新しい状態生成（不変性）', () => {
    const prev = createInitialState();
    const result = transitionMode(prev, 'NORMAL', 'resume', 1000);
    const next = applyTransition(prev, result);

    expect(next).not.toBe(prev);
    expect(prev.mode).toBe('STOPPED');
    expect(next.mode).toBe('NORMAL');
    expect(next.lastTransition).toEqual(result);
    expect(next.transitionCount).toBe(prev.transitionCount + 1);
  });

  it('isOperational: NORMALでtrue、STOPPEDでfalse', () => {
    const stopped = createInitialState();
    const toNormal = transitionMode(stopped, 'NORMAL', 'resume', 1000);
    const normal = applyTransition(stopped, toNormal);

    expect(isOperational(normal)).toBe(true);
    expect(isOperational(stopped)).toBe(false);
  });

  it('全結果がObject.freeze', () => {
    const initial = createInitialState();
    const result = transitionMode(initial, 'NORMAL', 'resume', 1000);
    const next = applyTransition(initial, result);

    expect(Object.isFrozen(initial)).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(next)).toBe(true);
    expect(next.lastTransition).not.toBeNull();
    expect(Object.isFrozen(next.lastTransition)).toBe(true);
  });
});
