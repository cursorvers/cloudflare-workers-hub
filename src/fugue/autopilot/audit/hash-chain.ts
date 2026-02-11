/**
 * Audit Hash Chain — Pure Functions
 *
 * SHA-256 hash chain linking each audit entry to its predecessor
 * for tamper detection. Uses Web Crypto API (available in CF Workers).
 *
 * Chain structure:
 *   entry_hash = SHA-256(chain_version | event_type | prev_hash | payload_json)
 *   prev_hash  = entry_hash of the preceding row (genesis = "0")
 *
 * All functions are pure and return frozen objects.
 */

// =============================================================================
// Constants
// =============================================================================

export const CHAIN_VERSION = 1;
export const GENESIS_HASH = '0';

// =============================================================================
// Types
// =============================================================================

export interface HashChainEntry {
  readonly chainVersion: number;
  readonly prevHash: string;
  readonly entryHash: string;
}

export interface HashChainInput {
  readonly eventType: string;
  readonly previousMode?: string | null;
  readonly newMode?: string | null;
  readonly reason?: string | null;
  readonly actor?: string | null;
  readonly metadata?: string | null;
}

export interface ChainVerificationResult {
  readonly valid: boolean;
  readonly checkedCount: number;
  readonly firstBreakIndex: number | null;
  readonly firstBreakReason: string | null;
}

// =============================================================================
// Hash Computation (Pure)
// =============================================================================

/**
 * Build the canonical payload string for hashing.
 * Deterministic: fields are ordered and nulls are normalised to empty string.
 */
export function buildHashPayload(
  chainVersion: number,
  eventType: string,
  prevHash: string,
  input: HashChainInput,
): string {
  const parts = [
    String(chainVersion),
    eventType,
    prevHash,
    input.previousMode ?? '',
    input.newMode ?? '',
    input.reason ?? '',
    input.actor ?? '',
    input.metadata ?? '',
  ];
  return parts.join('|');
}

/**
 * Compute SHA-256 hex digest of an arbitrary string.
 * Uses Web Crypto API (available in CF Workers runtime).
 */
export async function sha256Hex(data: string): Promise<string> {
  const encoder = new TextEncoder();
  const buf = await crypto.subtle.digest('SHA-256', encoder.encode(data));
  const bytes = new Uint8Array(buf);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Compute the entry hash for an audit entry given its predecessor hash.
 */
export async function computeEntryHash(
  prevHash: string,
  input: HashChainInput,
): Promise<string> {
  const payload = buildHashPayload(CHAIN_VERSION, input.eventType, prevHash, input);
  return sha256Hex(payload);
}

/**
 * Build a complete HashChainEntry (prevHash + entryHash).
 */
export async function buildChainEntry(
  prevHash: string,
  input: HashChainInput,
): Promise<HashChainEntry> {
  const entryHash = await computeEntryHash(prevHash, input);
  return Object.freeze({
    chainVersion: CHAIN_VERSION,
    prevHash,
    entryHash,
  });
}

// =============================================================================
// Chain Verification (Pure)
// =============================================================================

export interface StoredChainRow {
  readonly event_type: string;
  readonly previous_mode: string | null;
  readonly new_mode: string | null;
  readonly reason: string | null;
  readonly actor: string | null;
  readonly metadata: string | null;
  readonly prev_hash: string | null;
  readonly entry_hash: string | null;
  readonly chain_version: number | null;
}

/**
 * Verify a sequence of stored rows form a valid chain.
 * Rows must be ordered oldest-first (ascending by id).
 *
 * Checks:
 * 1. Each row's prev_hash matches the preceding row's entry_hash
 *    (first row's prev_hash must equal GENESIS_HASH).
 * 2. Each row's entry_hash matches the recomputed hash.
 */
export async function verifyChain(
  rows: readonly StoredChainRow[],
): Promise<ChainVerificationResult> {
  if (rows.length === 0) {
    return Object.freeze({
      valid: true,
      checkedCount: 0,
      firstBreakIndex: null,
      firstBreakReason: null,
    });
  }

  let expectedPrevHash = GENESIS_HASH;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];

    // Skip rows without hash chain data (pre-migration entries)
    if (row.entry_hash == null || row.prev_hash == null) {
      return Object.freeze({
        valid: false,
        checkedCount: i,
        firstBreakIndex: i,
        firstBreakReason: `row ${i}: missing hash chain data`,
      });
    }

    // Check prev_hash linkage
    if (row.prev_hash !== expectedPrevHash) {
      return Object.freeze({
        valid: false,
        checkedCount: i,
        firstBreakIndex: i,
        firstBreakReason: `row ${i}: prev_hash mismatch (expected ${expectedPrevHash.slice(0, 8)}…, got ${row.prev_hash.slice(0, 8)}…)`,
      });
    }

    // Recompute entry_hash
    const input: HashChainInput = {
      eventType: row.event_type,
      previousMode: row.previous_mode,
      newMode: row.new_mode,
      reason: row.reason,
      actor: row.actor,
      metadata: row.metadata,
    };
    const recomputed = await computeEntryHash(row.prev_hash, input);

    if (recomputed !== row.entry_hash) {
      return Object.freeze({
        valid: false,
        checkedCount: i,
        firstBreakIndex: i,
        firstBreakReason: `row ${i}: entry_hash mismatch (recomputed ${recomputed.slice(0, 8)}…, stored ${row.entry_hash.slice(0, 8)}…)`,
      });
    }

    expectedPrevHash = row.entry_hash;
  }

  return Object.freeze({
    valid: true,
    checkedCount: rows.length,
    firstBreakIndex: null,
    firstBreakReason: null,
  });
}

/**
 * Verify only the latest N entries (tail verification).
 * More efficient than full-chain verification for periodic checks.
 * Requires the entry_hash of the row immediately before the window
 * (or GENESIS_HASH if verifying from the start).
 */
export async function verifyTail(
  anchorHash: string,
  rows: readonly StoredChainRow[],
): Promise<ChainVerificationResult> {
  if (rows.length === 0) {
    return Object.freeze({
      valid: true,
      checkedCount: 0,
      firstBreakIndex: null,
      firstBreakReason: null,
    });
  }

  let expectedPrevHash = anchorHash;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];

    if (row.entry_hash == null || row.prev_hash == null) {
      return Object.freeze({
        valid: false,
        checkedCount: i,
        firstBreakIndex: i,
        firstBreakReason: `row ${i}: missing hash chain data`,
      });
    }

    if (row.prev_hash !== expectedPrevHash) {
      return Object.freeze({
        valid: false,
        checkedCount: i,
        firstBreakIndex: i,
        firstBreakReason: `row ${i}: prev_hash mismatch`,
      });
    }

    const input: HashChainInput = {
      eventType: row.event_type,
      previousMode: row.previous_mode,
      newMode: row.new_mode,
      reason: row.reason,
      actor: row.actor,
      metadata: row.metadata,
    };
    const recomputed = await computeEntryHash(row.prev_hash, input);

    if (recomputed !== row.entry_hash) {
      return Object.freeze({
        valid: false,
        checkedCount: i,
        firstBreakIndex: i,
        firstBreakReason: `row ${i}: entry_hash mismatch`,
      });
    }

    expectedPrevHash = row.entry_hash;
  }

  return Object.freeze({
    valid: true,
    checkedCount: rows.length,
    firstBreakIndex: null,
    firstBreakReason: null,
  });
}
