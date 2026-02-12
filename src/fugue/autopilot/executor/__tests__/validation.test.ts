import { describe, expect, it } from 'vitest';

import {
  ToolRequestSchema,
  ExecuteRequestSchema,
  validateExecuteRequest,
  MAX_EXECUTE_BODY_SIZE,
} from '../validation';
import { ToolCategory } from '../types';

// =============================================================================
// Factories
// =============================================================================

function makeValidRequest() {
  return {
    id: 'req-1',
    category: ToolCategory.FILE_READ,
    name: 'readFile',
    params: { path: '/tmp/x.txt' },
    effects: ['WRITE'],
    riskTier: 1,
    traceContext: {
      traceId: 'trace-1',
      spanId: 'span-1',
      timestamp: '2026-02-12T00:00:00.000Z',
    },
    attempt: 1,
    maxAttempts: 3,
    requestedAt: '2026-02-12T00:00:00.000Z',
    idempotencyKey: 'idem-1',
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('executor/validation', () => {
  describe('ToolRequestSchema', () => {
    it('accepts a valid request', () => {
      const result = ToolRequestSchema.safeParse(makeValidRequest());
      expect(result.success).toBe(true);
    });

    it('rejects missing id', () => {
      const req = { ...makeValidRequest(), id: undefined };
      const result = ToolRequestSchema.safeParse(req);
      expect(result.success).toBe(false);
    });

    it('rejects empty id', () => {
      const req = { ...makeValidRequest(), id: '' };
      const result = ToolRequestSchema.safeParse(req);
      expect(result.success).toBe(false);
    });

    it('rejects invalid category', () => {
      const req = { ...makeValidRequest(), category: 'INVALID_CAT' };
      const result = ToolRequestSchema.safeParse(req);
      expect(result.success).toBe(false);
    });

    it('accepts all valid categories', () => {
      for (const cat of Object.values(ToolCategory)) {
        const req = { ...makeValidRequest(), category: cat };
        const result = ToolRequestSchema.safeParse(req);
        expect(result.success).toBe(true);
      }
    });

    it('rejects riskTier out of range', () => {
      const req = { ...makeValidRequest(), riskTier: 5 };
      const result = ToolRequestSchema.safeParse(req);
      expect(result.success).toBe(false);
    });

    it('rejects negative riskTier', () => {
      const req = { ...makeValidRequest(), riskTier: -1 };
      const result = ToolRequestSchema.safeParse(req);
      expect(result.success).toBe(false);
    });

    it('accepts riskTier 0', () => {
      const req = { ...makeValidRequest(), riskTier: 0 };
      const result = ToolRequestSchema.safeParse(req);
      expect(result.success).toBe(true);
    });

    it('rejects extra unknown fields (strict mode)', () => {
      const req = { ...makeValidRequest(), extraField: 'evil' };
      const result = ToolRequestSchema.safeParse(req);
      expect(result.success).toBe(false);
    });

    it('rejects too many params keys', () => {
      const bigParams: Record<string, unknown> = {};
      for (let i = 0; i < 51; i++) bigParams[`key${i}`] = 'v';
      const req = { ...makeValidRequest(), params: bigParams };
      const result = ToolRequestSchema.safeParse(req);
      expect(result.success).toBe(false);
    });

    it('rejects too many effects', () => {
      const effects = Array.from({ length: 11 }, (_, i) => `E${i}`);
      const req = { ...makeValidRequest(), effects };
      const result = ToolRequestSchema.safeParse(req);
      expect(result.success).toBe(false);
    });

    it('rejects string id exceeding max length', () => {
      const req = { ...makeValidRequest(), id: 'x'.repeat(257) };
      const result = ToolRequestSchema.safeParse(req);
      expect(result.success).toBe(false);
    });

    it('rejects non-integer attempt', () => {
      const req = { ...makeValidRequest(), attempt: 1.5 };
      const result = ToolRequestSchema.safeParse(req);
      expect(result.success).toBe(false);
    });

    it('rejects attempt = 0', () => {
      const req = { ...makeValidRequest(), attempt: 0 };
      const result = ToolRequestSchema.safeParse(req);
      expect(result.success).toBe(false);
    });

    it('rejects missing traceContext', () => {
      const { traceContext, ...rest } = makeValidRequest();
      const result = ToolRequestSchema.safeParse(rest);
      expect(result.success).toBe(false);
    });

    it('rejects traceContext with extra fields', () => {
      const req = {
        ...makeValidRequest(),
        traceContext: { ...makeValidRequest().traceContext, extra: 'evil' },
      };
      const result = ToolRequestSchema.safeParse(req);
      expect(result.success).toBe(false);
    });
  });

  describe('ExecuteRequestSchema', () => {
    it('accepts wrapped valid request', () => {
      const result = ExecuteRequestSchema.safeParse({ request: makeValidRequest() });
      expect(result.success).toBe(true);
    });

    it('rejects bare request (not wrapped)', () => {
      const result = ExecuteRequestSchema.safeParse(makeValidRequest());
      expect(result.success).toBe(false);
    });

    it('rejects extra top-level fields', () => {
      const result = ExecuteRequestSchema.safeParse({
        request: makeValidRequest(),
        decision: { allowed: true },
      });
      expect(result.success).toBe(false);
    });
  });

  describe('validateExecuteRequest', () => {
    it('returns success for valid input', () => {
      const result = validateExecuteRequest({ request: makeValidRequest() });
      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
    });

    it('returns error message for invalid input', () => {
      const result = validateExecuteRequest({ request: { id: '' } });
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(typeof result.error).toBe('string');
    });

    it('result is frozen', () => {
      const result = validateExecuteRequest({ request: makeValidRequest() });
      expect(Object.isFrozen(result)).toBe(true);
    });
  });

  describe('MAX_EXECUTE_BODY_SIZE', () => {
    it('is 64 KB', () => {
      expect(MAX_EXECUTE_BODY_SIZE).toBe(64 * 1024);
    });
  });
});
