import type { TraceId, SpanId, TraceContext } from '../types/trace';

/**
 * Generate a new trace ID using crypto.randomUUID().
 *
 * WARNING: Trace IDs are for audit and correlation purposes ONLY.
 * NEVER use for authentication or authorization.
 */
export function generateTraceId(): TraceId {
  return crypto.randomUUID() as TraceId;
}

/**
 * Generate a new span ID (16-char hex string derived from UUID).
 *
 * WARNING: Span IDs are for audit and correlation purposes ONLY.
 * NEVER use for authentication or authorization.
 */
export function generateSpanId(): SpanId {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 16) as SpanId;
}

/**
 * Create a frozen trace context for a new operation.
 *
 * WARNING: Trace contexts are for audit and correlation purposes ONLY.
 * NEVER use for authentication or authorization.
 */
export function createTraceContext(parentSpanId?: SpanId): TraceContext {
  return Object.freeze({
    traceId: generateTraceId(),
    spanId: generateSpanId(),
    ...(parentSpanId ? { parentSpanId } : {}),
    timestamp: new Date().toISOString(),
  });
}
