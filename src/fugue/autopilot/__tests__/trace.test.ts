import { describe, expect, it, vi, afterEach } from 'vitest';

import {
  createTraceContext,
  generateSpanId,
  generateTraceId,
} from '../utils/trace';

const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SPAN_ID_REGEX = /^[0-9a-f]{16}$/i;

afterEach(() => {
  vi.useRealTimers();
});

describe('utils/trace', () => {
  describe('generateTraceId', () => {
    it('returns a UUID traceId', () => {
      const traceId = generateTraceId();
      expect(traceId).toMatch(UUID_V4_REGEX);
    });
  });

  describe('generateSpanId', () => {
    it('returns a 16-char hex spanId', () => {
      const spanId = generateSpanId();
      expect(spanId).toMatch(SPAN_ID_REGEX);
    });
  });

  describe('createTraceContext', () => {
    it('returns a correct frozen TraceContext (no parentSpanId)', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-02-11T00:00:00.000Z'));

      const ctx = createTraceContext();

      expect(Object.isFrozen(ctx)).toBe(true);
      expect(ctx.traceId).toMatch(UUID_V4_REGEX);
      expect(ctx.spanId).toMatch(SPAN_ID_REGEX);
      expect(ctx.timestamp).toBe('2026-02-11T00:00:00.000Z');
      expect('parentSpanId' in ctx).toBe(false);
    });

    it('includes parentSpanId when provided and result is frozen', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-02-11T01:02:03.004Z'));

      const parentSpanId = generateSpanId();
      const ctx = createTraceContext(parentSpanId);

      expect(Object.isFrozen(ctx)).toBe(true);
      expect(ctx.parentSpanId).toBe(parentSpanId);
      expect(ctx.timestamp).toBe('2026-02-11T01:02:03.004Z');
    });
  });
});

