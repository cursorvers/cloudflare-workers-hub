import { describe, it, expect } from 'vitest';
import { createVapidHeaders, createVapidJwt } from './vapid';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function base64UrlToBytes(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(base64 + padding);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const base64 = btoa(binary);
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlEncodeString(value: string): string {
  return bytesToBase64Url(textEncoder.encode(value));
}

function base64UrlDecodeString(value: string): string {
  return textDecoder.decode(base64UrlToBytes(value));
}

describe('createVapidJwt', () => {
  it('signs a JWT with ES256 using raw keys', async () => {
    const keyPair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify']
    );

    const publicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey));
    const privateJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey);

    const publicKey = bytesToBase64Url(publicRaw);
    const privateKey = privateJwk.d as string;

    const audience = 'https://push.example.com';
    const subject = 'mailto:ops@example.com';

    const { jwt, publicKey: normalizedPublicKey } = await createVapidJwt({
      audience,
      subject,
      publicKey,
      privateKey,
      expiresIn: 120,
    });

    expect(normalizedPublicKey).toBe(publicKey);

    const [headerSegment, payloadSegment, signatureSegment] = jwt.split('.');
    expect(headerSegment).toBeDefined();
    expect(payloadSegment).toBeDefined();
    expect(signatureSegment).toBeDefined();

    const header = JSON.parse(base64UrlDecodeString(headerSegment));
    const payload = JSON.parse(base64UrlDecodeString(payloadSegment));

    expect(header.alg).toBe('ES256');
    expect(header.typ).toBe('JWT');
    expect(payload.aud).toBe(audience);
    expect(payload.sub).toBe(subject);
    expect(payload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));

    const verified = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      keyPair.publicKey,
      base64UrlToBytes(signatureSegment),
      textEncoder.encode(`${headerSegment}.${payloadSegment}`)
    );

    expect(verified).toBe(true);
  });

  it('accepts JWK-encoded key material', async () => {
    const keyPair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify']
    );

    const publicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey));
    const publicKeyRaw = bytesToBase64Url(publicRaw);
    const publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
    const privateJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey);

    const publicKey = base64UrlEncodeString(
      JSON.stringify({
        kty: publicJwk.kty,
        crv: publicJwk.crv,
        x: publicJwk.x,
        y: publicJwk.y,
      })
    );

    const privateKey = base64UrlEncodeString(JSON.stringify(privateJwk));

    const { publicKey: normalizedPublicKey } = await createVapidJwt({
      audience: 'https://push.example.net',
      subject: 'mailto:security@example.net',
      publicKey,
      privateKey,
      expiresIn: 300,
    });

    expect(normalizedPublicKey).toBe(publicKeyRaw);
  });
});

describe('createVapidHeaders', () => {
  it('returns authorization and crypto-key headers', async () => {
    const keyPair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify']
    );

    const publicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey));
    const privateJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey);

    const publicKey = bytesToBase64Url(publicRaw);
    const privateKey = privateJwk.d as string;

    const { authorization, cryptoKey } = await createVapidHeaders({
      audience: 'https://push.example.org',
      subject: 'mailto:test@example.org',
      publicKey,
      privateKey,
      expiresIn: 600,
    });

    expect(authorization).toMatch(/^vapid t=.+, k=.+$/);
    expect(authorization).toContain(publicKey);
    expect(cryptoKey).toBe(`p256ecdsa=${publicKey}`);
  });
});
