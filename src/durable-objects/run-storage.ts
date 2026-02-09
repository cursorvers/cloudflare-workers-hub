/**
 * RunCoordinator Storage Layer
 *
 * Encapsulates all DO storage read/write operations and internal types.
 * Designed to be injected into the state machine for testability.
 */

import { z } from 'zod';
import {
  AgentTypeSchema,
  RunStatusSchema,
  StepStatusSchema,
  type AgentType,
  type RunStatus,
  type StepStatus,
} from '../schemas/orchestration';

// =============================================================================
// Internal Types (DO state is intentionally independent from D1 models)
// =============================================================================

export type ISODateTimeString = string;

export interface RunState {
  run_id: string;
  status: RunStatus;
  budget_usd: number;
  cost_usd: number;
  step_count: number;
  current_seq?: number;
  blocked_reason?: string;
  cancelled_reason?: string;
  created_at: ISODateTimeString;
  updated_at: ISODateTimeString;
}

export interface StepState {
  seq: number;
  status: StepStatus;
  agent: AgentType;
  attempts: number;
  max_attempts: number;
  idempotency_key: string;
  input: unknown;
  result?: unknown;
  error?: string;
  cost_usd: number;
  started_at?: ISODateTimeString;
  completed_at?: ISODateTimeString;
  updated_at: ISODateTimeString;
}

export interface IdempotencyRecord {
  key: string;
  stored_at: ISODateTimeString;
  result: unknown;
}

export interface IdempotencyHit {
  seq: number;
  key: string;
  result: unknown;
}

// =============================================================================
// Storage Key Builders
// =============================================================================

export function stepStorageKey(seq: number): string {
  return `step:${seq}`;
}

export function idempotencyStorageKey(key: string): string {
  return `idempotency:${key}`;
}

// =============================================================================
// Pure Helpers
// =============================================================================

export function nowIso(): string {
  return new Date().toISOString();
}

function hexFromArrayBuffer(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

function stableNormalizeJson(value: unknown): unknown {
  if (value === null) return null;
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean') return value;
  if (Array.isArray(value)) return value.map(stableNormalizeJson);
  if (t === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const out: Record<string, unknown> = {};
    for (const k of keys) out[k] = stableNormalizeJson(obj[k]);
    return out;
  }
  return null;
}

export async function hashJson(value: unknown): Promise<string> {
  const normalized = stableNormalizeJson(value);
  const json = JSON.stringify(normalized);
  const bytes = new TextEncoder().encode(json);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return `sha256:${hexFromArrayBuffer(digest)}`;
}

// =============================================================================
// Storage Interface (for DI / testability)
// =============================================================================

export interface RunStorage {
  getRun(): Promise<RunState | null>;
  putRun(run: RunState): Promise<void>;
  getStep(seq: number): Promise<StepState | null>;
  putStep(step: StepState): Promise<void>;
  listSteps(): Promise<StepState[]>;
  getIdempotency(key: string): Promise<IdempotencyRecord | null>;
  putIdempotency(key: string, record: IdempotencyRecord): Promise<void>;
}

// =============================================================================
// DO Storage Implementation
// =============================================================================

export class DORunStorage implements RunStorage {
  constructor(private readonly storage: DurableObjectStorage) {}

  async getRun(): Promise<RunState | null> {
    return (await this.storage.get<RunState>('run_state')) ?? null;
  }

  async putRun(run: RunState): Promise<void> {
    const parsed = RunStatusSchema.safeParse(run.status);
    if (!parsed.success) throw new Error(`Invalid run status: ${String(run.status)}`);
    await this.storage.put('run_state', run);
  }

  async getStep(seq: number): Promise<StepState | null> {
    return (await this.storage.get<StepState>(stepStorageKey(seq))) ?? null;
  }

  async putStep(step: StepState): Promise<void> {
    const parsed = StepStatusSchema.safeParse(step.status);
    if (!parsed.success) throw new Error(`Invalid step status: ${String(step.status)}`);
    await this.storage.put(stepStorageKey(step.seq), step);
  }

  async listSteps(): Promise<StepState[]> {
    const all = await this.storage.list<StepState>({ prefix: 'step:' });
    const steps: StepState[] = [];
    for (const [, v] of all) steps.push(v);
    return steps;
  }

  async getIdempotency(key: string): Promise<IdempotencyRecord | null> {
    return (await this.storage.get<IdempotencyRecord>(idempotencyStorageKey(key))) ?? null;
  }

  async putIdempotency(key: string, record: IdempotencyRecord): Promise<void> {
    await this.storage.put(idempotencyStorageKey(key), record);
  }
}
