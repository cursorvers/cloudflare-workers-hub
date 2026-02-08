import { describe, it, expect } from 'vitest';
import { handleLimitlessWebhookSimple } from './limitless-webhook-simple';

function makeEnv(overrides: Record<string, any> = {}) {
  return {
    // Env.AI is required by type but not used by this handler directly.
    AI: {} as any,
    ENVIRONMENT: 'test',
    ...overrides,
  } as any;
}

describe('Limitless Simple Webhook (KV-free)', () => {
  it('rejects without Authorization', async () => {
    const req = new Request('https://example.com/api/limitless/webhook-sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'masayuki' }),
    });
    const res = await handleLimitlessWebhookSimple(req, makeEnv({ MONITORING_API_KEY: 'k' }));
    expect(res.status).toBe(401);
  });

  it('accepts dedicated LIMITLESS_SYNC_WEBHOOK_KEY for auth check (but still fails if LIMITLESS_API_KEY missing)', async () => {
    const req = new Request('https://example.com/api/limitless/webhook-sync', {
      method: 'POST',
      headers: { Authorization: 'Bearer dedicated', 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'masayuki' }),
    });
    const res = await handleLimitlessWebhookSimple(
      req,
      makeEnv({ LIMITLESS_SYNC_WEBHOOK_KEY: 'dedicated' })
    );
    expect(res.status).toBe(500);
  });

  it('enforces dedicated LIMITLESS_SYNC_WEBHOOK_KEY exclusively when configured', async () => {
    const req = new Request('https://example.com/api/limitless/webhook-sync', {
      method: 'POST',
      headers: { Authorization: 'Bearer shared', 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'masayuki' }),
    });
    const res = await handleLimitlessWebhookSimple(
      req,
      makeEnv({ LIMITLESS_SYNC_WEBHOOK_KEY: 'dedicated', MONITORING_API_KEY: 'shared' })
    );
    expect(res.status).toBe(401);
  });

  it('rejects invalid JSON', async () => {
    const req = new Request('https://example.com/api/limitless/webhook-sync', {
      method: 'POST',
      headers: { Authorization: 'Bearer k', 'Content-Type': 'application/json' },
      body: '{',
    });
    const res = await handleLimitlessWebhookSimple(req, makeEnv({ MONITORING_API_KEY: 'k' }));
    expect(res.status).toBe(400);
  });

  it('fails safely when LIMITLESS_API_KEY missing', async () => {
    const req = new Request('https://example.com/api/limitless/webhook-sync', {
      method: 'POST',
      headers: { Authorization: 'Bearer k', 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'masayuki' }),
    });
    const res = await handleLimitlessWebhookSimple(req, makeEnv({ MONITORING_API_KEY: 'k' }));
    expect(res.status).toBe(500);
  });
});
