import { describe, expect, it, vi, beforeEach } from 'vitest';

import {
  verifyFullChain,
  verifyLatestEntries,
  getChainStatus,
  getLatestHash,
} from '../tamper-verifier';
import {
  GENESIS_HASH,
  computeEntryHash,
  type HashChainInput,
} from '../hash-chain';
import type { Env } from '../../../../types';

// =============================================================================
// Mock D1
// =============================================================================

interface MockStatement {
  bind: ReturnType<typeof vi.fn>;
  all: ReturnType<typeof vi.fn>;
  first: ReturnType<typeof vi.fn>;
  run: ReturnType<typeof vi.fn>;
}

function createMockDB() {
  const stmt: MockStatement = {
    bind: vi.fn().mockReturnThis(),
    all: vi.fn().mockResolvedValue({ results: [] }),
    first: vi.fn().mockResolvedValue(null),
    run: vi.fn().mockResolvedValue({}),
  };

  const db = {
    prepare: vi.fn().mockReturnValue(stmt),
    batch: vi.fn().mockResolvedValue([]),
    _stmt: stmt,
  };

  return db;
}

function createEnv(db?: ReturnType<typeof createMockDB>): Env {
  return {
    AI: {} as Ai,
    ENVIRONMENT: 'test',
    DB: db as unknown as D1Database,
  };
}

async function buildChainRows(count: number) {
  const rows = [];
  let prevHash = GENESIS_HASH;

  for (let i = 0; i < count; i++) {
    const input: HashChainInput = {
      eventType: 'mode_transition',
      previousMode: 'STOPPED',
      newMode: 'NORMAL',
      reason: `entry-${i}`,
      actor: 'test',
      metadata: null,
    };

    const entryHash = await computeEntryHash(prevHash, input);

    rows.push({
      event_type: input.eventType,
      previous_mode: input.previousMode,
      new_mode: input.newMode,
      reason: input.reason,
      actor: input.actor,
      metadata: input.metadata,
      prev_hash: prevHash,
      entry_hash: entryHash,
      chain_version: 1,
    });

    prevHash = entryHash;
  }

  return rows;
}

// =============================================================================
// Tests
// =============================================================================

describe('fugue/autopilot/audit/tamper-verifier', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('verifyFullChain', () => {
    it('returns invalid when DB not available', async () => {
      const env = createEnv();
      const result = await verifyFullChain(env);
      expect(result.valid).toBe(false);
      expect(result.firstBreakReason).toBe('DB not available');
    });

    it('returns valid for empty table', async () => {
      const db = createMockDB();
      db._stmt.all.mockResolvedValueOnce({ results: [] });
      const env = createEnv(db);
      const result = await verifyFullChain(env);
      expect(result.valid).toBe(true);
      expect(result.checkedCount).toBe(0);
    });

    it('returns valid for intact chain', async () => {
      const rows = await buildChainRows(3);
      const db = createMockDB();
      db._stmt.all.mockResolvedValueOnce({ results: rows });
      const env = createEnv(db);
      const result = await verifyFullChain(env);
      expect(result.valid).toBe(true);
      expect(result.checkedCount).toBe(3);
    });

    it('detects tampered chain', async () => {
      const rows = await buildChainRows(3);
      const tampered = [...rows];
      tampered[1] = { ...tampered[1], reason: 'TAMPERED' };

      const db = createMockDB();
      db._stmt.all.mockResolvedValueOnce({ results: tampered });
      const env = createEnv(db);
      const result = await verifyFullChain(env);
      expect(result.valid).toBe(false);
      expect(result.firstBreakIndex).toBe(1);
    });

    it('handles DB error gracefully', async () => {
      const db = createMockDB();
      db._stmt.all.mockRejectedValueOnce(new Error('DB connection lost'));
      const env = createEnv(db);
      const result = await verifyFullChain(env);
      expect(result.valid).toBe(false);
      expect(result.firstBreakReason).toContain('query error');
    });
  });

  describe('verifyLatestEntries', () => {
    it('returns invalid when DB not available', async () => {
      const env = createEnv();
      const result = await verifyLatestEntries(env, 10);
      expect(result.valid).toBe(false);
    });

    it('returns valid for empty table', async () => {
      const db = createMockDB();
      db._stmt.all.mockResolvedValueOnce({ results: [] });
      const env = createEnv(db);
      const result = await verifyLatestEntries(env, 10);
      expect(result.valid).toBe(true);
      expect(result.checkedCount).toBe(0);
    });

    it('verifies tail with genesis anchor', async () => {
      const rows = await buildChainRows(2);
      const db = createMockDB();
      // First call: get rows (newest first -> reversed internally)
      db._stmt.all.mockResolvedValueOnce({ results: [...rows].reverse() });
      // bind().first() for anchor: no row before window -> returns null -> GENESIS_HASH
      db._stmt.first.mockResolvedValueOnce(null);

      const env = createEnv(db);
      const result = await verifyLatestEntries(env, 10);
      expect(result.valid).toBe(true);
      expect(result.checkedCount).toBe(2);
    });

    it('verifies tail with real anchor', async () => {
      const rows = await buildChainRows(5);
      // Verify last 3 with row[1] as anchor
      const tailRows = rows.slice(2);
      const db = createMockDB();
      db._stmt.all.mockResolvedValueOnce({ results: [...tailRows].reverse() });
      db._stmt.first.mockResolvedValueOnce({ entry_hash: rows[1].entry_hash });

      const env = createEnv(db);
      const result = await verifyLatestEntries(env, 3);
      expect(result.valid).toBe(true);
      expect(result.checkedCount).toBe(3);
    });

    it('caps count at 1000', async () => {
      const db = createMockDB();
      db._stmt.all.mockResolvedValueOnce({ results: [] });
      const env = createEnv(db);
      await verifyLatestEntries(env, 5000);
      // Verify bind was called with capped value
      expect(db._stmt.bind).toHaveBeenCalledWith(1000);
    });

    it('handles DB error gracefully', async () => {
      const db = createMockDB();
      db._stmt.all.mockRejectedValueOnce(new Error('timeout'));
      const env = createEnv(db);
      const result = await verifyLatestEntries(env, 10);
      expect(result.valid).toBe(false);
      expect(result.firstBreakReason).toContain('query error');
    });
  });

  describe('getChainStatus', () => {
    it('returns unavailable when DB not available', async () => {
      const env = createEnv();
      const status = await getChainStatus(env);
      expect(status.chainIntegrity).toBe('unavailable');
      expect(Object.isFrozen(status)).toBe(true);
    });

    it('returns empty for no entries', async () => {
      const db = createMockDB();
      db._stmt.first
        .mockResolvedValueOnce({ total: 0, chained: 0 })
        .mockResolvedValueOnce(null);
      const env = createEnv(db);
      const status = await getChainStatus(env);
      expect(status.chainIntegrity).toBe('empty');
      expect(status.totalEntries).toBe(0);
    });

    it('returns ok when all entries are chained', async () => {
      const db = createMockDB();
      db._stmt.first
        .mockResolvedValueOnce({ total: 10, chained: 10 })
        .mockResolvedValueOnce({ entry_hash: 'abc123' });
      const env = createEnv(db);
      const status = await getChainStatus(env);
      expect(status.chainIntegrity).toBe('ok');
      expect(status.totalEntries).toBe(10);
      expect(status.chainedEntries).toBe(10);
      expect(status.latestHash).toBe('abc123');
    });

    it('returns partial when some entries lack hash', async () => {
      const db = createMockDB();
      db._stmt.first
        .mockResolvedValueOnce({ total: 10, chained: 5 })
        .mockResolvedValueOnce({ entry_hash: 'xyz789' });
      const env = createEnv(db);
      const status = await getChainStatus(env);
      expect(status.chainIntegrity).toBe('partial');
      expect(status.unchainedEntries).toBe(5);
    });

    it('handles DB error gracefully', async () => {
      const db = createMockDB();
      db._stmt.first.mockRejectedValueOnce(new Error('DB error'));
      const env = createEnv(db);
      const status = await getChainStatus(env);
      expect(status.chainIntegrity).toBe('unavailable');
    });
  });

  describe('getLatestHash', () => {
    it('returns GENESIS_HASH when DB not available', async () => {
      const env = createEnv();
      const hash = await getLatestHash(env);
      expect(hash).toBe(GENESIS_HASH);
    });

    it('returns GENESIS_HASH when no entries', async () => {
      const db = createMockDB();
      db._stmt.first.mockResolvedValueOnce(null);
      const env = createEnv(db);
      const hash = await getLatestHash(env);
      expect(hash).toBe(GENESIS_HASH);
    });

    it('returns latest entry_hash', async () => {
      const db = createMockDB();
      db._stmt.first.mockResolvedValueOnce({ entry_hash: 'latest-hash' });
      const env = createEnv(db);
      const hash = await getLatestHash(env);
      expect(hash).toBe('latest-hash');
    });

    it('returns GENESIS_HASH on DB error', async () => {
      const db = createMockDB();
      db._stmt.first.mockRejectedValueOnce(new Error('error'));
      const env = createEnv(db);
      const hash = await getLatestHash(env);
      expect(hash).toBe(GENESIS_HASH);
    });
  });
});
