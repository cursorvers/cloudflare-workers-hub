import { describe, expect, it } from 'vitest';

import { verifyWebhookSignature } from '../webhook-verifier';

async function sign(secret: string, timestamp: string, payload: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const base = `${timestamp}.${payload}`;
  const digest = await crypto.subtle.sign('HMAC', key, encoder.encode(base));

  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

describe('autopilot/auth/webhook-verifier', () => {
  it('正当な署名で成功', async () => {
    const payload = JSON.stringify({ event: 'ok' });
    const timestamp = '1700000000000';
    const secret = 'secret';
    const signature = await sign(secret, timestamp, payload);

    const result = await verifyWebhookSignature(
      payload,
      signature,
      secret,
      timestamp,
      { maxAgeMs: 5 * 60 * 1000 },
      1700000001000,
    );

    expect(result.valid).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('不正署名で失敗', async () => {
    const payload = JSON.stringify({ event: 'ok' });
    const result = await verifyWebhookSignature(
      payload,
      'bad-signature',
      'secret',
      '1700000000000',
      { maxAgeMs: 5 * 60 * 1000 },
      1700000001000,
    );

    expect(result.valid).toBe(false);
    expect(result.reason).toBe('invalid webhook signature');
  });

  it('timestamp窓外で失敗', async () => {
    const payload = JSON.stringify({ event: 'ok' });
    const timestamp = '1700000000000';
    const secret = 'secret';
    const signature = await sign(secret, timestamp, payload);

    const result = await verifyWebhookSignature(
      payload,
      signature,
      secret,
      timestamp,
      { maxAgeMs: 5 * 60 * 1000 },
      1700000900000,
    );

    expect(result.valid).toBe(false);
    expect(result.reason).toBe('webhook timestamp outside allowed window');
  });
});
