/**
 * Tamper Verifier — D1-backed Chain Integrity Checks
 *
 * Wraps pure hash-chain functions with D1 queries.
 * Provides: verifyFullChain, verifyLatestEntries, getChainStatus.
 */

import type { Env } from '../../../types';
import { safeLog } from '../../../utils/log-sanitizer';
import {
  verifyChain,
  verifyTail,
  GENESIS_HASH,
  type StoredChainRow,
  type ChainVerificationResult,
} from './hash-chain';

// =============================================================================
// Types
// =============================================================================

export interface ChainStatus {
  readonly totalEntries: number;
  readonly chainedEntries: number;
  readonly unchainedEntries: number;
  readonly latestHash: string | null;
  readonly chainIntegrity: 'ok' | 'broken' | 'partial' | 'empty' | 'unavailable';
}

// =============================================================================
// D1 Queries
// =============================================================================

const CHAIN_ROWS_SQL = `
  SELECT event_type, previous_mode, new_mode, reason, actor, metadata,
         prev_hash, entry_hash, chain_version
  FROM autopilot_audit_logs
  WHERE entry_hash IS NOT NULL
  ORDER BY id ASC
`;

const CHAIN_ROWS_TAIL_SQL = `
  SELECT event_type, previous_mode, new_mode, reason, actor, metadata,
         prev_hash, entry_hash, chain_version
  FROM autopilot_audit_logs
  WHERE entry_hash IS NOT NULL
  ORDER BY id DESC
  LIMIT ?
`;

const LATEST_HASH_SQL = `
  SELECT entry_hash FROM autopilot_audit_logs
  WHERE entry_hash IS NOT NULL
  ORDER BY id DESC
  LIMIT 1
`;

const COUNT_SQL = `
  SELECT
    COUNT(*) as total,
    COUNT(entry_hash) as chained
  FROM autopilot_audit_logs
`;

const ANCHOR_SQL = `
  SELECT entry_hash FROM autopilot_audit_logs
  WHERE entry_hash IS NOT NULL
  ORDER BY id DESC
  LIMIT 1 OFFSET ?
`;

// =============================================================================
// Verification Functions
// =============================================================================

/**
 * Verify the entire audit hash chain from genesis.
 * Use sparingly (reads all rows). Prefer verifyLatestEntries for periodic checks.
 */
export async function verifyFullChain(
  env: Env,
): Promise<ChainVerificationResult> {
  if (!env.DB) {
    return Object.freeze({
      valid: false,
      checkedCount: 0,
      firstBreakIndex: null,
      firstBreakReason: 'DB not available',
    });
  }

  try {
    const result = await env.DB.prepare(CHAIN_ROWS_SQL).all() as {
      results: StoredChainRow[];
    };
    const rows = result.results ?? [];
    return verifyChain(rows);
  } catch (err) {
    safeLog.error('[TamperVerifier] Full chain verification failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return Object.freeze({
      valid: false,
      checkedCount: 0,
      firstBreakIndex: null,
      firstBreakReason: `query error: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

/**
 * Verify only the latest N entries (tail verification).
 * Efficient for periodic alarm-based checks.
 */
export async function verifyLatestEntries(
  env: Env,
  count: number = 50,
): Promise<ChainVerificationResult> {
  if (!env.DB) {
    return Object.freeze({
      valid: false,
      checkedCount: 0,
      firstBreakIndex: null,
      firstBreakReason: 'DB not available',
    });
  }

  const safeCount = Math.min(Math.max(count, 1), 1000);

  try {
    // Get the latest N rows (newest first)
    const tailResult = await env.DB.prepare(CHAIN_ROWS_TAIL_SQL)
      .bind(safeCount)
      .all() as { results: StoredChainRow[] };

    const rowsDesc = tailResult.results ?? [];
    if (rowsDesc.length === 0) {
      return Object.freeze({
        valid: true,
        checkedCount: 0,
        firstBreakIndex: null,
        firstBreakReason: null,
      });
    }

    // Reverse to ascending order for verification
    const rows = [...rowsDesc].reverse();

    // Find anchor: the entry_hash of the row before our window
    const anchorResult = await env.DB.prepare(ANCHOR_SQL)
      .bind(safeCount)
      .first() as { entry_hash: string } | null;

    const anchorHash = anchorResult?.entry_hash ?? GENESIS_HASH;

    return verifyTail(anchorHash, rows);
  } catch (err) {
    safeLog.error('[TamperVerifier] Tail verification failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return Object.freeze({
      valid: false,
      checkedCount: 0,
      firstBreakIndex: null,
      firstBreakReason: `query error: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

/**
 * Get chain status summary for /status endpoint.
 */
export async function getChainStatus(
  env: Env,
): Promise<ChainStatus> {
  if (!env.DB) {
    return Object.freeze({
      totalEntries: 0,
      chainedEntries: 0,
      unchainedEntries: 0,
      latestHash: null,
      chainIntegrity: 'unavailable' as const,
    });
  }

  try {
    const [countRow, hashRow] = await Promise.all([
      env.DB.prepare(COUNT_SQL).first() as Promise<{ total: number; chained: number } | null>,
      env.DB.prepare(LATEST_HASH_SQL).first() as Promise<{ entry_hash: string } | null>,
    ]);

    const total = countRow?.total ?? 0;
    const chained = countRow?.chained ?? 0;
    const unchained = total - chained;
    const latestHash = hashRow?.entry_hash ?? null;

    let chainIntegrity: ChainStatus['chainIntegrity'];
    if (total === 0) {
      chainIntegrity = 'empty';
    } else if (chained === 0) {
      chainIntegrity = 'partial';
    } else if (unchained > 0) {
      chainIntegrity = 'partial';
    } else {
      chainIntegrity = 'ok';
    }

    return Object.freeze({
      totalEntries: total,
      chainedEntries: chained,
      unchainedEntries: unchained,
      latestHash,
      chainIntegrity,
    });
  } catch (err) {
    safeLog.error('[TamperVerifier] getChainStatus failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return Object.freeze({
      totalEntries: 0,
      chainedEntries: 0,
      unchainedEntries: 0,
      latestHash: null,
      chainIntegrity: 'unavailable' as const,
    });
  }
}

/**
 * Get the latest entry_hash in the chain.
 * Returns GENESIS_HASH if no chained entries exist.
 */
export async function getLatestHash(
  env: Env,
): Promise<string> {
  if (!env.DB) return GENESIS_HASH;

  try {
    const row = await env.DB.prepare(LATEST_HASH_SQL).first() as { entry_hash: string } | null;
    return row?.entry_hash ?? GENESIS_HASH;
  } catch (err) {
    safeLog.error('[TamperVerifier] getLatestHash failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return GENESIS_HASH;
  }
}
