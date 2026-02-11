import { describe, expect, it } from 'vitest';

import {
  CHAIN_VERSION,
  GENESIS_HASH,
  buildHashPayload,
  sha256Hex,
  computeEntryHash,
  buildChainEntry,
  verifyChain,
  verifyTail,
  type HashChainInput,
  type StoredChainRow,
} from '../hash-chain';

// =============================================================================
// Helpers
// =============================================================================

function makeInput(overrides: Partial<HashChainInput> = {}): HashChainInput {
  return {
    eventType: 'mode_transition',
    previousMode: 'STOPPED',
    newMode: 'NORMAL',
    reason: 'test',
    actor: 'admin',
    metadata: null,
    ...overrides,
  };
}

async function makeRow(
  prevHash: string,
  input: HashChainInput,
): Promise<StoredChainRow> {
  const entryHash = await computeEntryHash(prevHash, input);
  return {
    event_type: input.eventType,
    previous_mode: input.previousMode ?? null,
    new_mode: input.newMode ?? null,
    reason: input.reason ?? null,
    actor: input.actor ?? null,
    metadata: input.metadata ?? null,
    prev_hash: prevHash,
    entry_hash: entryHash,
    chain_version: CHAIN_VERSION,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('fugue/autopilot/audit/hash-chain', () => {
  describe('constants', () => {
    it('CHAIN_VERSION is 1', () => {
      expect(CHAIN_VERSION).toBe(1);
    });

    it('GENESIS_HASH is "0"', () => {
      expect(GENESIS_HASH).toBe('0');
    });
  });

  describe('buildHashPayload', () => {
    it('produces deterministic pipe-separated string', () => {
      const input = makeInput();
      const payload = buildHashPayload(CHAIN_VERSION, 'mode_transition', '0', input);
      expect(payload).toBe('1|mode_transition|0|STOPPED|NORMAL|test|admin|');
    });

    it('normalises null fields to empty string', () => {
      const input = makeInput({ previousMode: null, actor: null, metadata: null });
      const payload = buildHashPayload(CHAIN_VERSION, 'guard_check', 'abc', input);
      expect(payload).toContain('||');
      expect(payload).not.toContain('null');
    });

    it('includes metadata when present', () => {
      const input = makeInput({ metadata: '{"key":"value"}' });
      const payload = buildHashPayload(CHAIN_VERSION, 'mode_transition', '0', input);
      expect(payload).toContain('{"key":"value"}');
    });
  });

  describe('sha256Hex', () => {
    it('returns 64 char hex string', async () => {
      const hash = await sha256Hex('hello');
      expect(hash).toHaveLength(64);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('is deterministic', async () => {
      const a = await sha256Hex('test-data');
      const b = await sha256Hex('test-data');
      expect(a).toBe(b);
    });

    it('different inputs produce different hashes', async () => {
      const a = await sha256Hex('input-a');
      const b = await sha256Hex('input-b');
      expect(a).not.toBe(b);
    });

    it('empty string produces valid hash', async () => {
      const hash = await sha256Hex('');
      expect(hash).toHaveLength(64);
    });
  });

  describe('computeEntryHash', () => {
    it('returns 64 char hex string', async () => {
      const hash = await computeEntryHash(GENESIS_HASH, makeInput());
      expect(hash).toHaveLength(64);
    });

    it('different prevHash produces different entryHash', async () => {
      const input = makeInput();
      const a = await computeEntryHash('aaa', input);
      const b = await computeEntryHash('bbb', input);
      expect(a).not.toBe(b);
    });

    it('different input produces different entryHash', async () => {
      const a = await computeEntryHash('0', makeInput({ reason: 'reason-a' }));
      const b = await computeEntryHash('0', makeInput({ reason: 'reason-b' }));
      expect(a).not.toBe(b);
    });
  });

  describe('buildChainEntry', () => {
    it('returns frozen HashChainEntry', async () => {
      const entry = await buildChainEntry(GENESIS_HASH, makeInput());
      expect(Object.isFrozen(entry)).toBe(true);
      expect(entry.chainVersion).toBe(CHAIN_VERSION);
      expect(entry.prevHash).toBe(GENESIS_HASH);
      expect(entry.entryHash).toHaveLength(64);
    });

    it('chains correctly from previous entry', async () => {
      const first = await buildChainEntry(GENESIS_HASH, makeInput());
      const second = await buildChainEntry(first.entryHash, makeInput({ reason: 'second' }));
      expect(second.prevHash).toBe(first.entryHash);
      expect(second.entryHash).not.toBe(first.entryHash);
    });
  });

  describe('verifyChain', () => {
    it('valid for empty chain', async () => {
      const result = await verifyChain([]);
      expect(result.valid).toBe(true);
      expect(result.checkedCount).toBe(0);
      expect(Object.isFrozen(result)).toBe(true);
    });

    it('valid for single-entry chain', async () => {
      const input = makeInput();
      const row = await makeRow(GENESIS_HASH, input);
      const result = await verifyChain([row]);
      expect(result.valid).toBe(true);
      expect(result.checkedCount).toBe(1);
    });

    it('valid for multi-entry chain', async () => {
      const input1 = makeInput({ reason: 'first' });
      const row1 = await makeRow(GENESIS_HASH, input1);

      const input2 = makeInput({ reason: 'second' });
      const row2 = await makeRow(row1.entry_hash!, input2);

      const input3 = makeInput({ reason: 'third' });
      const row3 = await makeRow(row2.entry_hash!, input3);

      const result = await verifyChain([row1, row2, row3]);
      expect(result.valid).toBe(true);
      expect(result.checkedCount).toBe(3);
    });

    it('detects missing hash chain data', async () => {
      const row: StoredChainRow = {
        event_type: 'mode_transition',
        previous_mode: null,
        new_mode: null,
        reason: null,
        actor: null,
        metadata: null,
        prev_hash: null,
        entry_hash: null,
        chain_version: null,
      };
      const result = await verifyChain([row]);
      expect(result.valid).toBe(false);
      expect(result.firstBreakIndex).toBe(0);
      expect(result.firstBreakReason).toContain('missing hash chain data');
    });

    it('detects prev_hash mismatch', async () => {
      const input1 = makeInput({ reason: 'first' });
      const row1 = await makeRow(GENESIS_HASH, input1);

      const input2 = makeInput({ reason: 'second' });
      const row2 = await makeRow('wrong-prev-hash', input2);

      const result = await verifyChain([row1, row2]);
      expect(result.valid).toBe(false);
      expect(result.firstBreakIndex).toBe(1);
      expect(result.firstBreakReason).toContain('prev_hash mismatch');
    });

    it('detects entry_hash tampering', async () => {
      const input1 = makeInput({ reason: 'first' });
      const row1 = await makeRow(GENESIS_HASH, input1);

      const tampered: StoredChainRow = {
        ...row1,
        entry_hash: 'deadbeef'.repeat(8),
      };

      const result = await verifyChain([tampered]);
      expect(result.valid).toBe(false);
      expect(result.firstBreakIndex).toBe(0);
      expect(result.firstBreakReason).toContain('entry_hash mismatch');
    });

    it('detects reason tampering mid-chain', async () => {
      const row1 = await makeRow(GENESIS_HASH, makeInput({ reason: 'first' }));
      const row2 = await makeRow(row1.entry_hash!, makeInput({ reason: 'second' }));
      const row3 = await makeRow(row2.entry_hash!, makeInput({ reason: 'third' }));

      // Tamper with row2's reason (but keep hashes)
      const tampered2: StoredChainRow = { ...row2, reason: 'TAMPERED' };

      const result = await verifyChain([row1, tampered2, row3]);
      expect(result.valid).toBe(false);
      expect(result.firstBreakIndex).toBe(1);
    });

    it('result is frozen', async () => {
      const result = await verifyChain([]);
      expect(Object.isFrozen(result)).toBe(true);
    });
  });

  describe('verifyTail', () => {
    it('valid for empty tail', async () => {
      const result = await verifyTail(GENESIS_HASH, []);
      expect(result.valid).toBe(true);
      expect(result.checkedCount).toBe(0);
    });

    it('valid with correct anchor', async () => {
      const row1 = await makeRow(GENESIS_HASH, makeInput({ reason: 'first' }));
      const row2 = await makeRow(row1.entry_hash!, makeInput({ reason: 'second' }));
      const row3 = await makeRow(row2.entry_hash!, makeInput({ reason: 'third' }));

      // Verify only rows 2-3 with row1's hash as anchor
      const result = await verifyTail(row1.entry_hash!, [row2, row3]);
      expect(result.valid).toBe(true);
      expect(result.checkedCount).toBe(2);
    });

    it('detects wrong anchor', async () => {
      const row1 = await makeRow(GENESIS_HASH, makeInput({ reason: 'first' }));
      const row2 = await makeRow(row1.entry_hash!, makeInput({ reason: 'second' }));

      const result = await verifyTail('wrong-anchor', [row2]);
      expect(result.valid).toBe(false);
      expect(result.firstBreakIndex).toBe(0);
    });

    it('result is frozen', async () => {
      const result = await verifyTail(GENESIS_HASH, []);
      expect(Object.isFrozen(result)).toBe(true);
    });
  });
});
