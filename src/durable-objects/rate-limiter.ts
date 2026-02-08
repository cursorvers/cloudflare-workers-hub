/**
 * RateLimiter Durable Object
 *
 * KV-based rate limiting can easily blow up daily KV write quotas because it writes on every request.
 * This DO keeps counters in memory (best-effort). If it restarts, limits may temporarily reset.
 *
 * Design goals:
 * - eliminate KV puts on hot paths
 * - keep behavior close to existing 1-minute bucket limiter
 * - fail-open on errors
 */

import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../types';

type Counter = { count: number; expiresAtMs: number };

type CheckRequest = {
  key: string;
  limit: number;
  ttlSec: number;
  windowStartSec: number;
  windowSec: number;
};

export class RateLimiter extends DurableObject<Env> {
  private counters = new Map<string, Counter>();
  private reqsSinceSweep = 0;

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== '/check' || request.method !== 'POST') {
      return new Response('Not found', { status: 404 });
    }

    let body: CheckRequest;
    try {
      body = (await request.json()) as CheckRequest;
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    const key = String(body.key || '');
    const limit = Number(body.limit);
    const ttlSec = Number(body.ttlSec);
    const windowStartSec = Number(body.windowStartSec);
    const windowSec = Number(body.windowSec);

    if (!key || !Number.isFinite(limit) || limit <= 0 || !Number.isFinite(ttlSec) || ttlSec <= 0 || !Number.isFinite(windowStartSec) || !Number.isFinite(windowSec)) {
      return new Response(JSON.stringify({ error: 'Invalid input' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    const nowMs = Date.now();

    // Opportunistic cleanup to keep memory bounded.
    this.reqsSinceSweep++;
    if (this.reqsSinceSweep >= 1000 || this.counters.size > 20000) {
      this.reqsSinceSweep = 0;
      for (const [k, v] of this.counters.entries()) {
        if (v.expiresAtMs <= nowMs) this.counters.delete(k);
      }
      // Extreme safety valve.
      if (this.counters.size > 50000) this.counters.clear();
    }

    const existing = this.counters.get(key);
    const fresh = existing && existing.expiresAtMs > nowMs ? existing : null;
    const current = fresh?.count ?? 0;

    const resetAtMs = (windowStartSec + windowSec) * 1000;
    if (current >= limit) {
      const retryAfter = Math.max(1, Math.ceil((resetAtMs - nowMs) / 1000));
      return new Response(
        JSON.stringify({ allowed: false, remaining: 0, retryAfter }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const newCount = current + 1;
    const expiresAtMs = nowMs + ttlSec * 1000;
    this.counters.set(key, { count: newCount, expiresAtMs });

    return new Response(
      JSON.stringify({ allowed: true, remaining: Math.max(0, limit - newCount) }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

