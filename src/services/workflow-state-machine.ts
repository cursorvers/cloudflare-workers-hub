/**
 * Workflow State Machine for Receipt Processing
 *
 * Implements Case B-3 (Hybrid) architecture:
 * - Centralized state transition rules
 * - Distributed execution
 * - Audit log for all transitions
 *
 * State Flow:
 * pending_validation → validated → classified → extracting → extracted
 * → uploading_r2 → uploaded_r2 → submitting_freee → freee_uploaded
 * → mapping_account → finding_partner → creating_deal → linking_receipt
 * → completed
 *
 * Terminal States: completed, failed
 * Review State: needs_review (can transition to any valid state)
 */

import type { Env } from '../types';
import { safeLog } from '../utils/log-sanitizer';

// =============================================================================
// Types
// =============================================================================

export type ReceiptStatus =
  | 'pending_validation'
  | 'validated'
  | 'classified'
  | 'extracting'
  | 'extracted'
  | 'uploading_r2'
  | 'uploaded_r2'
  | 'submitting_freee'
  | 'freee_uploaded'
  | 'mapping_account'
  | 'finding_partner'
  | 'creating_deal'
  | 'linking_receipt'
  | 'completed'
  | 'failed'
  | 'needs_review';

export type EventType =
  | 'state_transition'
  | 'classification_result'
  | 'freee_submission'
  | 'freee_response'
  | 'error_occurred'
  | 'manual_intervention'
  | 'retry_attempt';

export interface Receipt {
  id: string;
  file_hash: string;
  r2_object_key: string;
  freee_receipt_id?: string;
  transaction_date: string;
  vendor_name: string;
  amount: number;
  currency: string;
  document_type: string;
  status: ReceiptStatus;
  error_message?: string;
  error_code?: string;
  retry_count: number;
  created_at: string;
  updated_at: string;
}

export interface AuditLog {
  receipt_id: string;
  event_type: EventType;
  previous_status?: ReceiptStatus;
  new_status?: ReceiptStatus;
  metadata?: Record<string, any>;
  user_id?: string;
  ip_address?: string;
}

// =============================================================================
// State Transition Rules
// =============================================================================

const VALID_TRANSITIONS: Record<ReceiptStatus, ReceiptStatus[]> = {
  pending_validation: ['validated', 'failed'],
  validated: ['classified', 'failed'],
  classified: ['extracting', 'needs_review', 'failed'],
  extracting: ['extracted', 'failed'],
  extracted: ['uploading_r2', 'failed'],
  uploading_r2: ['uploaded_r2', 'failed'],
  uploaded_r2: ['submitting_freee', 'failed'],
  submitting_freee: ['freee_uploaded', 'failed', 'needs_review'],
  // Deal automation states
  freee_uploaded: ['mapping_account', 'completed', 'failed'],
  mapping_account: ['finding_partner', 'needs_review', 'failed'],
  finding_partner: ['creating_deal', 'needs_review', 'failed'],
  creating_deal: ['linking_receipt', 'needs_review', 'failed'],
  linking_receipt: ['completed', 'failed'],
  // Terminal & recovery states
  completed: [], // Terminal state
  failed: ['pending_validation', 'freee_uploaded', 'needs_review'], // Can retry from upload or start
  needs_review: [
    'validated',
    'classified',
    'extracting',
    'extracted',
    'uploading_r2',
    'uploaded_r2',
    'submitting_freee',
    'freee_uploaded',
    'mapping_account',
    'finding_partner',
    'creating_deal',
    'linking_receipt',
    'failed',
  ], // Can transition to any state
};

// =============================================================================
// Workflow State Machine Class
// =============================================================================

export class WorkflowStateMachine {
  private env: Env;
  private db: D1Database;
  private receiptId: string;

  constructor(env: Env, receiptId: string) {
    this.env = env;
    if (!env.DB) {
      // Callers should guard this, but keep a hard runtime check to avoid silent corruption.
      throw new Error('DB not configured');
    }
    this.db = env.DB;
    this.receiptId = receiptId;
  }

  /**
   * Get current receipt state
   */
  async getCurrentState(): Promise<Receipt | null> {
    const result = await this.db.prepare(
      'SELECT * FROM receipts WHERE id = ?'
    )
      .bind(this.receiptId)
      .first<Receipt>();

    return result;
  }

  /**
   * Validate state transition
   */
  isValidTransition(from: ReceiptStatus, to: ReceiptStatus): boolean {
    const allowedTransitions = VALID_TRANSITIONS[from];
    if (!allowedTransitions) {
      return false;
    }
    return allowedTransitions.includes(to);
  }

  /**
   * Transition to new state
   */
  async transition(
    to: ReceiptStatus,
    metadata?: Record<string, any>
  ): Promise<void> {
    const receipt = await this.getCurrentState();
    if (!receipt) {
      throw new Error(`Receipt ${this.receiptId} not found`);
    }

    const from = receipt.status as ReceiptStatus;

    // Validate transition
    if (!this.isValidTransition(from, to)) {
      throw new Error(`Invalid transition: ${from} -> ${to}`);
    }

    // Start transaction
    await this.db.batch([
      // Update receipt status
      this.db.prepare(
        "UPDATE receipts SET status = ?, updated_at = datetime('now') WHERE id = ?"
      ).bind(to, this.receiptId),

      // Insert audit log
      this.db.prepare(
        `INSERT INTO audit_logs (receipt_id, event_type, previous_status, new_status, metadata)
         VALUES (?, ?, ?, ?, ?)`
      ).bind(
        this.receiptId,
        'state_transition',
        from,
        to,
        JSON.stringify(metadata || {})
      ),
    ]);

    safeLog(this.env, 'info', 'State transition', {
      receiptId: this.receiptId,
      from,
      to,
      metadata,
    });
  }

  /**
   * Record error
   */
  async recordError(
    errorMessage: string,
    errorCode: string,
    metadata?: Record<string, any>
  ): Promise<void> {
    await this.db.batch([
      // Update receipt with error
      this.db.prepare(
        `UPDATE receipts
         SET error_message = ?, error_code = ?, retry_count = retry_count + 1,
             last_retry_at = datetime('now'), updated_at = datetime('now')
         WHERE id = ?`
      ).bind(errorMessage, errorCode, this.receiptId),

      // Insert audit log
      this.db.prepare(
        `INSERT INTO audit_logs (receipt_id, event_type, metadata)
         VALUES (?, ?, ?)`
      ).bind(
        this.receiptId,
        'error_occurred',
        JSON.stringify({ errorMessage, errorCode, ...metadata })
      ),
    ]);

    safeLog(this.env, 'error', 'Error recorded', {
      receiptId: this.receiptId,
      errorMessage,
      errorCode,
      metadata,
    });
  }

  /**
   * Check if retry allowed
   */
  async canRetry(maxRetries: number = 3): Promise<boolean> {
    const receipt = await this.getCurrentState();
    if (!receipt) {
      return false;
    }
    return receipt.retry_count < maxRetries;
  }

  /**
   * Execute workflow step
   */
  async executeStep(
    step: string,
    handler: () => Promise<void>
  ): Promise<void> {
    try {
      await handler();
    } catch (error: any) {
      await this.recordError(error.message, 'WORKFLOW_STEP_FAILED', {
        step,
        stack: error.stack,
      });

      // Check if retry allowed
      if (await this.canRetry()) {
        // Schedule retry (implement with Queue Consumer)
        safeLog(this.env, 'info', 'Scheduling retry', {
          receiptId: this.receiptId,
          step,
        });
      } else {
        // Move to failed state
        await this.transition('failed', { reason: 'Max retries exceeded' });
      }

      throw error;
    }
  }

  /**
   * Get audit trail
   */
  async getAuditTrail(): Promise<AuditLog[]> {
    const results = await this.db.prepare(
      `SELECT * FROM audit_logs WHERE receipt_id = ? ORDER BY created_at ASC`
    )
      .bind(this.receiptId)
      .all<AuditLog>();

    return results.results || [];
  }

  /**
   * Complete workflow
   */
  async complete(freeeReceiptId: string): Promise<void> {
    await this.db.batch([
      // Update receipt
      this.db.prepare(
        `UPDATE receipts
         SET status = ?, freee_receipt_id = ?, completed_at = datetime('now'),
             updated_at = datetime('now')
         WHERE id = ?`
      ).bind('completed', freeeReceiptId, this.receiptId),

      // Insert audit log
      this.db.prepare(
        `INSERT INTO audit_logs (receipt_id, event_type, new_status, metadata)
         VALUES (?, ?, ?, ?)`
      ).bind(
        this.receiptId,
        'state_transition',
        'completed',
        JSON.stringify({ freeeReceiptId })
      ),
    ]);

    safeLog(this.env, 'info', 'Workflow completed', {
      receiptId: this.receiptId,
      freeeReceiptId,
    });
  }
}

// =============================================================================
// Factory Function
// =============================================================================

export function createStateMachine(
  env: Env,
  receiptId: string
): WorkflowStateMachine {
  return new WorkflowStateMachine(env, receiptId);
}
