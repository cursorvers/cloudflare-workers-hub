import { describe, expect, it } from 'vitest';

import {
  createDedupState,
  computeFingerprint,
  checkDedup,
  cleanupExpired,
  serializeDedupState,
  deserializeDedupState,
  DEFAULT_DEDUP_WINDOW_MS,
  MAX_DEDUP_ENTRIES,
} from '../notification-dedup';

// =============================================================================
// Tests
// =============================================================================

describe('Phase 5b: notification-dedup', () => {
  describe('computeFingerprint', () => {
    it('generates mode-aware fingerprint', () => {
      const fp1 = computeFingerprint('auto_stop', 'NORMAL');
      const fp2 = computeFingerprint('auto_stop', 'DEGRADED');
      expect(fp1).not.toBe(fp2);
    });

    it('includes metadata reason in fingerprint', () => {
      const fp1 = computeFingerprint('auto_stop', 'NORMAL', { reason: 'budget' });
      const fp2 = computeFingerprint('auto_stop', 'NORMAL', { reason: 'circuit' });
      expect(fp1).not.toBe(fp2);
    });

    it('truncates long metadata reason', () => {
      const longReason = 'x'.repeat(200);
      const fp = computeFingerprint('auto_stop', 'NORMAL', { reason: longReason });
      expect(fp.length).toBeLessThan(200);
    });
  });

  describe('checkDedup', () => {
    it('allows first occurrence', () => {
      const state = createDedupState();
      const { decision, nextState } = checkDedup(state, 'fp-1', 1000);

      expect(decision.shouldNotify).toBe(true);
      expect(decision.reason).toBe('first occurrence');
      expect(nextState.entries.size).toBe(1);
    });

    it('suppresses duplicate within window', () => {
      const state = createDedupState();
      const { nextState: state1 } = checkDedup(state, 'fp-1', 1000);
      const { decision } = checkDedup(state1, 'fp-1', 2000);

      expect(decision.shouldNotify).toBe(false);
      expect(decision.suppressedCount).toBe(1);
    });

    it('allows after window expires', () => {
      const state = createDedupState();
      const { nextState: state1 } = checkDedup(state, 'fp-1', 1000);
      const { decision } = checkDedup(state1, 'fp-1', 1000 + DEFAULT_DEDUP_WINDOW_MS + 1);

      expect(decision.shouldNotify).toBe(true);
      expect(decision.reason).toBe('previous entry expired');
    });

    it('allows different fingerprints independently', () => {
      const state = createDedupState();
      const { nextState: state1 } = checkDedup(state, 'fp-1', 1000);
      const { decision } = checkDedup(state1, 'fp-2', 1000);

      expect(decision.shouldNotify).toBe(true);
    });

    it('increments count on suppression', () => {
      let state = createDedupState();
      state = checkDedup(state, 'fp-1', 1000).nextState;
      state = checkDedup(state, 'fp-1', 2000).nextState;
      const { decision } = checkDedup(state, 'fp-1', 3000);

      expect(decision.suppressedCount).toBe(2);
    });

    it('respects custom window', () => {
      const state = createDedupState();
      const { nextState: state1 } = checkDedup(state, 'fp-1', 1000, 500);
      const { decision } = checkDedup(state1, 'fp-1', 1600);

      expect(decision.shouldNotify).toBe(true); // 600ms > 500ms window
    });
  });

  describe('cleanupExpired', () => {
    it('removes expired entries', () => {
      let state = createDedupState();
      state = checkDedup(state, 'fp-1', 1000, 100).nextState; // Expires at 1100
      state = checkDedup(state, 'fp-2', 2000, 100).nextState; // Expires at 2100

      const cleaned = cleanupExpired(state, 1500);
      expect(cleaned.entries.size).toBe(1);
      expect(cleaned.entries.has('fp-2')).toBe(true);
    });

    it('caps at MAX_DEDUP_ENTRIES', () => {
      let state = createDedupState();
      for (let i = 0; i < MAX_DEDUP_ENTRIES + 10; i++) {
        state = checkDedup(state, `fp-${i}`, 1000 + i, 999_999).nextState;
      }

      const cleaned = cleanupExpired(state, 1000);
      expect(cleaned.entries.size).toBeLessThanOrEqual(MAX_DEDUP_ENTRIES);
    });
  });

  describe('serialization', () => {
    it('round-trips through serialize/deserialize', () => {
      let state = createDedupState();
      state = checkDedup(state, 'fp-1', 1000).nextState;
      state = checkDedup(state, 'fp-2', 2000).nextState;

      const serialized = serializeDedupState(state);
      const deserialized = deserializeDedupState(serialized);

      expect(deserialized.entries.size).toBe(2);
      expect(deserialized.entries.get('fp-1')?.count).toBe(1);
    });

    it('handles undefined data gracefully', () => {
      const state = deserializeDedupState(undefined);
      expect(state.entries.size).toBe(0);
    });

    it('filters invalid entries during deserialization', () => {
      const badData = { 'fp-1': { invalid: true } } as unknown as Record<string, never>;
      const state = deserializeDedupState(badData);
      expect(state.entries.size).toBe(0);
    });
  });

  describe('constants', () => {
    it('DEFAULT_DEDUP_WINDOW_MS is 5 minutes', () => {
      expect(DEFAULT_DEDUP_WINDOW_MS).toBe(5 * 60 * 1000);
    });

    it('MAX_DEDUP_ENTRIES is 100', () => {
      expect(MAX_DEDUP_ENTRIES).toBe(100);
    });
  });
});
