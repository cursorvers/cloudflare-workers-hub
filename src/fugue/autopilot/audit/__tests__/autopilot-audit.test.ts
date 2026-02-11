import { describe, expect, it, vi, beforeEach } from 'vitest';

import {
  AUTOPILOT_AUDIT_EVENT_TYPES,
  writeAuditEntry,
  writeAuditBatch,
  queryAuditLogs,
  countAuditEntries,
  auditModeTransition,
  auditGuardCheck,
  auditAutoStop,
  auditRecovery,
  auditBudgetUpdate,
  auditTaskDLQ,
} from '../autopilot-audit';
import type { Env } from '../../../../types';

function createMockDB() {
  const runSpy = vi.fn().mockResolvedValue({ meta: { changes: 1 } });
  const bindSpy = vi.fn().mockReturnValue({ run: runSpy, all: vi.fn().mockResolvedValue({ results: [] }), first: vi.fn().mockResolvedValue(null) });
  const prepareSpy = vi.fn().mockReturnValue({ bind: bindSpy });
  const batchSpy = vi.fn().mockResolvedValue([]);
  return {
    prepare: prepareSpy,
    batch: batchSpy,
    _spies: { prepareSpy, bindSpy, runSpy, batchSpy },
  };
}

function createEnv(db?: ReturnType<typeof createMockDB>): Env {
  return {
    AI: {} as Ai,
    ENVIRONMENT: 'test',
    DB: db as unknown as D1Database | undefined,
  };
}

describe('fugue/autopilot/audit/autopilot-audit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // =========================================================================
  // Event Types
  // =========================================================================

  describe('Event Types', () => {
    it('exports all 11 event types', () => {
      expect(AUTOPILOT_AUDIT_EVENT_TYPES).toHaveLength(11);
      expect(AUTOPILOT_AUDIT_EVENT_TYPES).toContain('mode_transition');
      expect(AUTOPILOT_AUDIT_EVENT_TYPES).toContain('auto_stop');
      expect(AUTOPILOT_AUDIT_EVENT_TYPES).toContain('task_dlq');
    });
  });

  // =========================================================================
  // Write Operations
  // =========================================================================

  describe('writeAuditEntry', () => {
    it('writes entry to D1 with prepared statement', async () => {
      const db = createMockDB();
      const env = createEnv(db);
      const ok = await writeAuditEntry(env, {
        eventType: 'mode_transition',
        previousMode: 'STOPPED',
        newMode: 'NORMAL',
        reason: 'manual start',
        actor: 'admin',
      });

      expect(ok).toBe(true);
      expect(db._spies.prepareSpy).toHaveBeenCalledTimes(1);
      expect(db._spies.bindSpy).toHaveBeenCalledWith(
        'mode_transition', 'STOPPED', 'NORMAL', 'manual start', 'admin', null,
      );
      expect(db._spies.runSpy).toHaveBeenCalledTimes(1);
    });

    it('returns false when DB is not available', async () => {
      const env = createEnv(undefined);
      const ok = await writeAuditEntry(env, {
        eventType: 'guard_check',
      });
      expect(ok).toBe(false);
    });

    it('serializes metadata as JSON', async () => {
      const db = createMockDB();
      const env = createEnv(db);
      await writeAuditEntry(env, {
        eventType: 'budget_update',
        metadata: { spent: 150, limit: 200 },
      });

      const bindArgs = db._spies.bindSpy.mock.calls[0];
      expect(JSON.parse(bindArgs[5])).toEqual({ spent: 150, limit: 200 });
    });

    it('handles DB errors gracefully', async () => {
      const db = createMockDB();
      db._spies.runSpy.mockRejectedValueOnce(new Error('D1 error'));
      const env = createEnv(db);

      const ok = await writeAuditEntry(env, {
        eventType: 'alarm_error',
        reason: 'timeout',
      });
      expect(ok).toBe(false);
    });
  });

  // =========================================================================
  // Batch Write
  // =========================================================================

  describe('writeAuditBatch', () => {
    it('writes multiple entries atomically', async () => {
      const db = createMockDB();
      const env = createEnv(db);
      const ok = await writeAuditBatch(env, [
        { eventType: 'mode_transition', previousMode: 'STOPPED', newMode: 'NORMAL', reason: 'start' },
        { eventType: 'guard_check', metadata: { verdict: 'CONTINUE' } },
      ]);

      expect(ok).toBe(true);
      expect(db._spies.batchSpy).toHaveBeenCalledTimes(1);
      expect(db._spies.prepareSpy).toHaveBeenCalledTimes(2);
    });

    it('returns true for empty batch', async () => {
      const db = createMockDB();
      const env = createEnv(db);
      const ok = await writeAuditBatch(env, []);
      expect(ok).toBe(true);
      expect(db._spies.batchSpy).not.toHaveBeenCalled();
    });

    it('returns false when DB unavailable', async () => {
      const env = createEnv(undefined);
      const ok = await writeAuditBatch(env, [{ eventType: 'guard_check' }]);
      expect(ok).toBe(false);
    });
  });

  // =========================================================================
  // Query Operations
  // =========================================================================

  describe('queryAuditLogs', () => {
    it('queries with default limit and offset', async () => {
      const db = createMockDB();
      const allSpy = vi.fn().mockResolvedValue({
        results: [
          { id: 1, event_type: 'mode_transition', previous_mode: 'STOPPED', new_mode: 'NORMAL', reason: 'test', actor: null, metadata: null, created_at: '2026-01-01' },
        ],
      });
      db._spies.bindSpy.mockReturnValue({ all: allSpy });
      const env = createEnv(db);

      const results = await queryAuditLogs(env);
      expect(results).toHaveLength(1);
      expect(Object.isFrozen(results)).toBe(true);
    });

    it('returns empty array when DB unavailable', async () => {
      const env = createEnv(undefined);
      const results = await queryAuditLogs(env);
      expect(results).toEqual([]);
    });

    it('caps limit at 200', async () => {
      const db = createMockDB();
      const allSpy = vi.fn().mockResolvedValue({ results: [] });
      db._spies.bindSpy.mockReturnValue({ all: allSpy });
      const env = createEnv(db);

      await queryAuditLogs(env, { limit: 500 });
      const bindArgs = db._spies.bindSpy.mock.calls[0];
      expect(bindArgs[0]).toBe(200);
    });
  });

  // =========================================================================
  // Count
  // =========================================================================

  describe('countAuditEntries', () => {
    it('returns 0 when DB unavailable', async () => {
      const env = createEnv(undefined);
      const count = await countAuditEntries(env);
      expect(count).toBe(0);
    });

    it('counts entries by event type', async () => {
      const db = createMockDB();
      const firstSpy = vi.fn().mockResolvedValue({ count: 5 });
      db._spies.bindSpy.mockReturnValue({ first: firstSpy });
      const env = createEnv(db);

      const count = await countAuditEntries(env, 'auto_stop');
      expect(count).toBe(5);
    });
  });

  // =========================================================================
  // Convenience Helpers
  // =========================================================================

  describe('Convenience Helpers', () => {
    it('auditModeTransition writes correct entry', async () => {
      const db = createMockDB();
      const env = createEnv(db);
      await auditModeTransition(env, 'STOPPED', 'NORMAL', 'manual resume', 'admin@test.com');

      expect(db._spies.bindSpy).toHaveBeenCalledWith(
        'mode_transition', 'STOPPED', 'NORMAL', 'manual resume', 'admin@test.com', null,
      );
    });

    it('auditGuardCheck includes verdict in metadata', async () => {
      const db = createMockDB();
      const env = createEnv(db);
      await auditGuardCheck(env, 'STOP', ['budget critical'], ['budget warning']);

      const bindArgs = db._spies.bindSpy.mock.calls[0];
      const meta = JSON.parse(bindArgs[5]);
      expect(meta.verdict).toBe('STOP');
      expect(meta.reasons).toEqual(['budget critical']);
    });

    it('auditAutoStop sets correct modes', async () => {
      const db = createMockDB();
      const env = createEnv(db);
      await auditAutoStop(env, 'NORMAL', ['budget critical', 'circuit open']);

      expect(db._spies.bindSpy).toHaveBeenCalledWith(
        'auto_stop', 'NORMAL', 'STOPPED',
        'budget critical; circuit open',
        null,
        expect.any(String),
      );
    });

    it('auditRecovery handles approved and denied', async () => {
      const db = createMockDB();
      const env = createEnv(db);

      await auditRecovery(env, true, 'admin', 'all checks pass');
      expect(db._spies.bindSpy.mock.calls[0][0]).toBe('recovery_approved');

      await auditRecovery(env, false, 'admin', 'denied');
      expect(db._spies.bindSpy.mock.calls[1][0]).toBe('recovery_denied');
    });

    it('auditBudgetUpdate includes ratio', async () => {
      const db = createMockDB();
      const env = createEnv(db);
      await auditBudgetUpdate(env, 150, 200);

      const bindArgs = db._spies.bindSpy.mock.calls[0];
      const meta = JSON.parse(bindArgs[5]);
      expect(meta.ratio).toBe(0.75);
    });

    it('auditTaskDLQ includes task details', async () => {
      const db = createMockDB();
      const env = createEnv(db);
      await auditTaskDLQ(env, 'task-123', 'NOTIFICATION', 'timeout');

      expect(db._spies.bindSpy.mock.calls[0][0]).toBe('task_dlq');
      expect(db._spies.bindSpy.mock.calls[0][3]).toBe('timeout');
    });
  });
});
