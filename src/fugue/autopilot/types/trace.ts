/**
 * Trace context type definitions for FUGUE Autopilot.
 * Provides branded identifiers for trace and span IDs.
 *
 * WARNING: Trace IDs are for audit and correlation purposes ONLY.
 * NEVER use for authentication or authorization.
 */

declare const TraceIdBrand: unique symbol;
declare const SpanIdBrand: unique symbol;

/** Branded trace identifier. */
export type TraceId = string & { readonly [TraceIdBrand]: typeof TraceIdBrand };

/** Branded span identifier. */
export type SpanId = string & { readonly [SpanIdBrand]: typeof SpanIdBrand };

export interface TraceContext {
  readonly traceId: TraceId;
  readonly spanId: SpanId;
  readonly parentSpanId?: SpanId;
  readonly timestamp: string;
}
