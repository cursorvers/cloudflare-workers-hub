/**
 * Zod validation schemas for executor API input.
 *
 * Enforces strict typing, length limits, and enum constraints
 * to prevent injection, over-sized payloads, and CB pollution.
 */

import { z } from 'zod';
import { ToolCategory, ErrorCode } from './types';

// =============================================================================
// Constants
// =============================================================================

/** Maximum JSON body size in bytes for /execute requests. */
export const MAX_EXECUTE_BODY_SIZE = 64 * 1024; // 64 KB

const MAX_STRING_LENGTH = 256;
const MAX_PARAMS_KEYS = 50;
const MAX_EFFECTS = 10;

// =============================================================================
// Reusable Schemas
// =============================================================================

const traceContextSchema = z.object({
  traceId: z.string().min(1).max(MAX_STRING_LENGTH),
  spanId: z.string().min(1).max(MAX_STRING_LENGTH),
  timestamp: z.string().min(1).max(MAX_STRING_LENGTH),
}).strict();

// =============================================================================
// ToolRequest Schema
// =============================================================================

const toolCategoryValues = Object.values(ToolCategory) as [string, ...string[]];

export const ToolRequestSchema = z.object({
  id: z.string().min(1).max(MAX_STRING_LENGTH),
  category: z.enum(toolCategoryValues),
  name: z.string().min(1).max(MAX_STRING_LENGTH),
  params: z.record(z.unknown()).refine(
    (obj) => Object.keys(obj).length <= MAX_PARAMS_KEYS,
    { message: `params must have at most ${MAX_PARAMS_KEYS} keys` },
  ),
  effects: z.array(z.string().min(1).max(MAX_STRING_LENGTH)).max(MAX_EFFECTS),
  riskTier: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  traceContext: traceContextSchema,
  attempt: z.number().int().min(1).max(100),
  maxAttempts: z.number().int().min(1).max(100),
  requestedAt: z.string().min(1).max(MAX_STRING_LENGTH),
  idempotencyKey: z.string().min(1).max(MAX_STRING_LENGTH),
}).strict();

export type ValidatedToolRequest = z.infer<typeof ToolRequestSchema>;

// =============================================================================
// Execute Request Schema (wraps ToolRequest for the API endpoint)
// =============================================================================

export const ExecuteRequestSchema = z.object({
  request: ToolRequestSchema,
}).strict();

export type ValidatedExecuteRequest = z.infer<typeof ExecuteRequestSchema>;

// =============================================================================
// Validation Helper
// =============================================================================

export interface ValidationResult<T> {
  readonly success: boolean;
  readonly data?: T;
  readonly error?: string;
}

export function validateExecuteRequest(body: unknown): ValidationResult<ValidatedExecuteRequest> {
  const result = ExecuteRequestSchema.safeParse(body);
  if (result.success) {
    return Object.freeze({ success: true, data: result.data });
  }
  const message = result.error.issues
    .map((i) => `${i.path.join('.')}: ${i.message}`)
    .join('; ');
  return Object.freeze({ success: false, error: message });
}
