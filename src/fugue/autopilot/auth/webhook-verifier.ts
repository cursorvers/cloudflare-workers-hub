import type { WebhookVerification } from './types';
import { constantTimeCompare } from './authenticator';

function freezeVerification(result: WebhookVerification): WebhookVerification {
  return Object.freeze({ ...result });
}

function invalid(reason: string): WebhookVerification {
  return freezeVerification({ valid: false, reason });
}

function valid(reason: string): WebhookVerification {
  return freezeVerification({ valid: true, reason });
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function parseTimestampMs(timestampHeader: string): number | null {
  const parsed = Number(timestampHeader);
  if (!Number.isFinite(parsed)) return null;

  // Accept both epoch seconds and epoch milliseconds.
  if (parsed < 1e12) return Math.trunc(parsed * 1000);
  return Math.trunc(parsed);
}

/**
 * Verify webhook signature using HMAC-SHA256 + timestamp window.
 */
export async function verifyWebhookSignature(
  payload: string,
  signature: string,
  secret: string,
  timestampHeader: string,
  config: { readonly maxAgeMs: number },
  nowMs: number = Date.now(),
): Promise<WebhookVerification> {
  if (!secret) return invalid('missing webhook secret');
  if (!signature) return invalid('missing webhook signature');
  if (!timestampHeader) return invalid('missing webhook timestamp');

  const timestampMs = parseTimestampMs(timestampHeader);
  if (timestampMs === null) return invalid('invalid webhook timestamp');

  const ageMs = Math.abs(nowMs - timestampMs);
  if (ageMs > config.maxAgeMs) {
    return invalid('webhook timestamp outside allowed window');
  }

  const encoder = new TextEncoder();
  const base = `${timestampHeader}.${payload}`;

  try {
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );

    const digest = await crypto.subtle.sign('HMAC', key, encoder.encode(base));
    const expected = toHex(digest);

    if (!constantTimeCompare(expected, signature)) {
      return invalid('invalid webhook signature');
    }

    return valid('webhook signature verified');
  } catch {
    return invalid('webhook verification error');
  }
}

/**
 * Nonce replay check abstraction (KV TTL-backed in production).
 */
export function isNonceUsed(
  nonce: string,
  usedNonces: ReadonlySet<string>,
): boolean {
  return usedNonces.has(nonce);
}
