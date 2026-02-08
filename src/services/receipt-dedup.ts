/**
 * Receipt Deduplication Service
 *
 * Prevents duplicate receipt uploads to freee by checking SHA-256 hash.
 * Uses KV storage to track uploaded receipts.
 */

import type { Env } from '../types';
import { safeLog } from '../utils/log-sanitizer';

// =============================================================================
// Types
// =============================================================================

export interface ReceiptRecord {
  hash: string;
  fileName: string;
  source: 'gmail' | 'web' | 'manual';
  freeeReceiptId?: number;
  uploadedAt: string;
  fileSize: number;
}

export interface DedupResult {
  isDuplicate: boolean;
  existingRecord?: ReceiptRecord;
  hash: string;
}

// =============================================================================
// Hash Calculation
// =============================================================================

/**
 * Calculate SHA-256 hash of file content
 */
async function calculateHash(content: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', content);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

// =============================================================================
// Receipt Deduplication Service
// =============================================================================

export class ReceiptDedupService {
  private env: Env;
  private kv: KVNamespace;
  private prefix = 'receipt:hash:';
  // TTL: 1 year (receipts older than 1 year are unlikely to be re-uploaded)
  private ttlSeconds = 365 * 24 * 60 * 60;

  constructor(env: Env) {
    this.env = env;
    if (!env.KV) {
      throw new Error('KV not configured');
    }
    this.kv = env.KV;
  }

  /**
   * Check if receipt already exists (by content hash)
   */
  async checkDuplicate(content: ArrayBuffer): Promise<DedupResult> {
    const hash = await calculateHash(content);
    const key = `${this.prefix}${hash}`;

    const existing = await this.kv.get(key, 'json');

    if (existing) {
      safeLog(this.env, 'info', '[ReceiptDedup] Duplicate detected', {
        hash: hash.substring(0, 16) + '...',
        existingFileName: (existing as ReceiptRecord).fileName,
      });

      return {
        isDuplicate: true,
        existingRecord: existing as ReceiptRecord,
        hash,
      };
    }

    return {
      isDuplicate: false,
      hash,
    };
  }

  /**
   * Record uploaded receipt (call after successful freee upload)
   */
  async recordUpload(
    hash: string,
    fileName: string,
    source: 'gmail' | 'web' | 'manual',
    fileSize: number,
    freeeReceiptId?: number
  ): Promise<void> {
    const key = `${this.prefix}${hash}`;

    const record: ReceiptRecord = {
      hash,
      fileName,
      source,
      freeeReceiptId,
      uploadedAt: new Date().toISOString(),
      fileSize,
    };

    await this.kv.put(key, JSON.stringify(record), {
      expirationTtl: this.ttlSeconds,
    });

    safeLog(this.env, 'info', '[ReceiptDedup] Receipt recorded', {
      hash: hash.substring(0, 16) + '...',
      fileName,
      source,
      freeeReceiptId,
    });
  }

  /**
   * Get receipt record by hash
   */
  async getRecord(hash: string): Promise<ReceiptRecord | null> {
    const key = `${this.prefix}${hash}`;
    return this.kv.get(key, 'json');
  }

  /**
   * Delete receipt record (for manual cleanup)
   */
  async deleteRecord(hash: string): Promise<void> {
    const key = `${this.prefix}${hash}`;
    await this.kv.delete(key);

    safeLog(this.env, 'info', '[ReceiptDedup] Receipt record deleted', {
      hash: hash.substring(0, 16) + '...',
    });
  }

  /**
   * Check and upload receipt to freee (convenience method)
   * Returns null if duplicate, otherwise returns the result of uploadFn
   */
  async checkAndUpload<T>(
    content: ArrayBuffer,
    fileName: string,
    source: 'gmail' | 'web' | 'manual',
    uploadFn: () => Promise<T & { receipt?: { id: number } }>
  ): Promise<{ uploaded: true; result: T } | { uploaded: false; reason: 'duplicate'; existingRecord: ReceiptRecord }> {
    // Check for duplicate
    const dedupResult = await this.checkDuplicate(content);

    if (dedupResult.isDuplicate && dedupResult.existingRecord) {
      return {
        uploaded: false,
        reason: 'duplicate',
        existingRecord: dedupResult.existingRecord,
      };
    }

    // Upload to freee
    const result = await uploadFn();

    // Record the upload
    await this.recordUpload(
      dedupResult.hash,
      fileName,
      source,
      content.byteLength,
      result.receipt?.id
    );

    return {
      uploaded: true,
      result,
    };
  }
}

// =============================================================================
// Factory Function
// =============================================================================

export function createReceiptDedupService(env: Env): ReceiptDedupService {
  return new ReceiptDedupService(env);
}
