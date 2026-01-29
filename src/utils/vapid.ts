/**
 * VAPID (Voluntary Application Server Identification) Utilities
 *
 * Implements JWT signing for Web Push Protocol (RFC 8030)
 * Uses Web Crypto API available in Cloudflare Workers
 */

/**
 * Generate VAPID key pair
 * Run this once to generate keys, then store in environment variables
 */
export async function generateVAPIDKeys(): Promise<{
  publicKey: string;
  privateKey: string;
}> {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: 'ECDSA',
      namedCurve: 'P-256',
    },
    true,
    ['sign', 'verify']
  );

  const publicKeyJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
  const privateKeyJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey);

  // Convert to base64url
  const publicKey = base64UrlEncode(
    JSON.stringify({
      kty: publicKeyJwk.kty,
      crv: publicKeyJwk.crv,
      x: publicKeyJwk.x,
      y: publicKeyJwk.y,
    })
  );

  const privateKey = base64UrlEncode(JSON.stringify(privateKeyJwk));

  return { publicKey, privateKey };
}

/**
 * Generate VAPID Authorization header
 */
export async function generateVAPIDHeader(
  audience: string,
  subject: string,
  privateKeyJwk: string,
  publicKeyBase64: string,
  expiresIn: number = 12 * 60 * 60 // 12 hours
): Promise<string> {
  const header = {
    typ: 'JWT',
    alg: 'ES256',
  };

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    aud: audience,
    exp: now + expiresIn,
    sub: subject,
  };

  // Import private key
  const privateKeyData = JSON.parse(base64UrlDecode(privateKeyJwk));
  const privateKey = await crypto.subtle.importKey(
    'jwk',
    privateKeyData,
    {
      name: 'ECDSA',
      namedCurve: 'P-256',
    },
    false,
    ['sign']
  );

  // Create JWT
  const headerBase64 = base64UrlEncode(JSON.stringify(header));
  const payloadBase64 = base64UrlEncode(JSON.stringify(payload));
  const unsignedToken = `${headerBase64}.${payloadBase64}`;

  // Sign
  const signature = await crypto.subtle.sign(
    {
      name: 'ECDSA',
      hash: 'SHA-256',
    },
    privateKey,
    new TextEncoder().encode(unsignedToken)
  );

  const signatureBase64 = arrayBufferToBase64Url(signature);
  const jwt = `${unsignedToken}.${signatureBase64}`;

  return `vapid t=${jwt}, k=${publicKeyBase64}`;
}

/**
 * Base64 URL encode
 */
function base64UrlEncode(str: string): string {
  const base64 = btoa(str);
  return base64
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

/**
 * Base64 URL decode
 */
function base64UrlDecode(str: string): string {
  const base64 = str
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  return atob(base64 + padding);
}

/**
 * Convert ArrayBuffer to base64url
 */
function arrayBufferToBase64Url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const base64 = btoa(binary);
  return base64
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}
