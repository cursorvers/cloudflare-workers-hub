import { describe, expect, it } from 'vitest';

import {
  createMetricsState,
  recordModeTransition,
  recordExecution,
  recordGuardVerdict,
  createSnapshot,
  exportPrometheus,
  createOpsSummary,
  RING_BUFFER_SIZE,
  type ModeTransitionMetric,
  type ExecutionMetric,
  type GuardVerdictMetric,
} from '../collector';

// =============================================================================
// Helpers
// =============================================================================

function makeTransition(from: string, to: string, timestamp = Date.now()): ModeTransitionMetric {
  return Object.freeze({ from, to, reason: 'test', timestamp });
}

function makeExecution(
  success: boolean,
  durationMs = 100,
  async_ = false,
  timestamp = Date.now(),
): ExecutionMetric {
  return Object.freeze({
    category: 'CODE_EXECUTION',
    success,
    durationMs,
    async: async_,
    timestamp,
  });
}

function makeVerdict(verdict: string, timestamp = Date.now()): GuardVerdictMetric {
  return Object.freeze({ verdict, reasons: Object.freeze([]), timestamp });
}

// =============================================================================
// Tests
// =============================================================================

describe('Phase 6: metrics collector', () => {
  describe('createMetricsState', () => {
    it('creates initial frozen state', () => {
      const state = createMetricsState(1000);
      expect(state.startedAt).toBe(1000);
      expect(state.modeTransitionTotal).toBe(0);
      expect(state.executionTotal).toBe(0);
      expect(state.guardVerdictTotal).toBe(0);
      expect(state.currentMode).toBe('STOPPED');
      expect(Object.isFrozen(state)).toBe(true);
    });
  });

  describe('recordModeTransition', () => {
    it('increments total and updates current mode', () => {
      let state = createMetricsState(1000);
      state = recordModeTransition(state, makeTransition('STOPPED', 'NORMAL', 2000));

      expect(state.modeTransitionTotal).toBe(1);
      expect(state.currentMode).toBe('NORMAL');
      expect(state.modeEnteredAt).toBe(2000);
      expect(state.modeTransitions).toHaveLength(1);
    });

    it('maintains ring buffer limit', () => {
      let state = createMetricsState(1000);
      for (let i = 0; i < RING_BUFFER_SIZE + 10; i++) {
        state = recordModeTransition(state, makeTransition('A', 'B', 1000 + i));
      }

      expect(state.modeTransitions).toHaveLength(RING_BUFFER_SIZE);
      expect(state.modeTransitionTotal).toBe(RING_BUFFER_SIZE + 10);
    });
  });

  describe('recordExecution', () => {
    it('counts successes and failures separately', () => {
      let state = createMetricsState(1000);
      state = recordExecution(state, makeExecution(true));
      state = recordExecution(state, makeExecution(true));
      state = recordExecution(state, makeExecution(false));

      expect(state.executionTotal).toBe(3);
      expect(state.executionSucceeded).toBe(2);
      expect(state.executionFailed).toBe(1);
    });

    it('tracks async executions', () => {
      let state = createMetricsState(1000);
      state = recordExecution(state, makeExecution(true, 100, true));
      state = recordExecution(state, makeExecution(true, 100, false));

      expect(state.executionAsyncCount).toBe(1);
    });
  });

  describe('recordGuardVerdict', () => {
    it('counts verdicts by type', () => {
      let state = createMetricsState(1000);
      state = recordGuardVerdict(state, makeVerdict('CONTINUE'));
      state = recordGuardVerdict(state, makeVerdict('CONTINUE'));
      state = recordGuardVerdict(state, makeVerdict('DEGRADE'));
      state = recordGuardVerdict(state, makeVerdict('STOP'));

      expect(state.guardVerdictTotal).toBe(4);
      expect(state.guardContinueCount).toBe(2);
      expect(state.guardDegradeCount).toBe(1);
      expect(state.guardStopCount).toBe(1);
    });
  });

  describe('createSnapshot', () => {
    it('computes average duration from successful executions', () => {
      let state = createMetricsState(1000);
      state = recordExecution(state, makeExecution(true, 200));
      state = recordExecution(state, makeExecution(true, 400));
      state = recordExecution(state, makeExecution(false, 9999)); // Excluded

      const snapshot = createSnapshot(state);
      expect(snapshot.executions.avgDurationMs).toBe(300); // (200+400)/2
    });

    it('handles zero executions gracefully', () => {
      const state = createMetricsState(1000);
      const snapshot = createSnapshot(state);
      expect(snapshot.executions.avgDurationMs).toBe(0);
    });

    it('snapshot is frozen', () => {
      const state = createMetricsState(1000);
      const snapshot = createSnapshot(state);
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(Object.isFrozen(snapshot.executions)).toBe(true);
      expect(Object.isFrozen(snapshot.guardVerdicts)).toBe(true);
      expect(Object.isFrozen(snapshot.uptime)).toBe(true);
    });
  });

  describe('exportPrometheus', () => {
    it('generates valid Prometheus text format', () => {
      let state = createMetricsState(1000);
      state = recordModeTransition(state, makeTransition('STOPPED', 'NORMAL'));
      state = recordExecution(state, makeExecution(true, 100));
      state = recordExecution(state, makeExecution(false, 50));
      state = recordGuardVerdict(state, makeVerdict('CONTINUE'));

      const snapshot = createSnapshot(state);
      const text = exportPrometheus(snapshot);

      expect(text).toContain('autopilot_mode_transitions_total 1');
      expect(text).toContain('autopilot_executions_total{result="success"} 1');
      expect(text).toContain('autopilot_executions_total{result="failure"} 1');
      expect(text).toContain('autopilot_guard_verdicts_total{verdict="CONTINUE"} 1');
      expect(text).toContain('autopilot_current_mode{mode="NORMAL"} 1');
      expect(text).toMatch(/# HELP/);
      expect(text).toMatch(/# TYPE/);
    });
  });

  describe('createOpsSummary', () => {
    it('creates compact summary with provider health', () => {
      let state = createMetricsState(1000);
      state = recordModeTransition(state, makeTransition('STOPPED', 'NORMAL', 2000));
      state = recordExecution(state, makeExecution(true, 100));

      const snapshot = createSnapshot(state);
      const providers = [
        { provider: 'openai', available: true, successRate: 1.0 },
        { provider: 'glm', available: false, successRate: 0.3 },
      ];

      const summary = createOpsSummary(snapshot, providers);
      expect(summary.mode).toBe('NORMAL');
      expect(summary.modeTransitions).toBe(1);
      expect((summary.executions as { successRate: number }).successRate).toBe(1.0);
      expect((summary.providers as { id: string }[])).toHaveLength(2);
    });

    it('handles zero executions', () => {
      const state = createMetricsState(1000);
      const snapshot = createSnapshot(state);
      const summary = createOpsSummary(snapshot, []);
      expect((summary.executions as { successRate: number }).successRate).toBe(1.0);
    });
  });

  describe('immutability', () => {
    it('all state transitions produce frozen objects', () => {
      let state = createMetricsState(1000);
      expect(Object.isFrozen(state)).toBe(true);

      state = recordModeTransition(state, makeTransition('A', 'B'));
      expect(Object.isFrozen(state)).toBe(true);
      expect(Object.isFrozen(state.modeTransitions)).toBe(true);

      state = recordExecution(state, makeExecution(true));
      expect(Object.isFrozen(state)).toBe(true);

      state = recordGuardVerdict(state, makeVerdict('CONTINUE'));
      expect(Object.isFrozen(state)).toBe(true);
    });
  });

  describe('constants', () => {
    it('RING_BUFFER_SIZE is 60', () => {
      expect(RING_BUFFER_SIZE).toBe(60);
    });
  });
});
