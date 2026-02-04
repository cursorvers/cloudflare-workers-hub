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

  const publicKeyRaw = await crypto.subtle.exportKey('raw', keyPair.publicKey);
  const privateKeyJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey);

  const publicKey = bytesToBase64Url(publicKeyRaw);

  if (!privateKeyJwk.d) {
    throw new Error('Failed to export VAPID private key');
  }

  return { publicKey, privateKey: privateKeyJwk.d };
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
  const { authorization } = await createVapidHeaders({
    audience,
    subject,
    publicKey: publicKeyBase64,
    privateKey: privateKeyJwk,
    expiresIn,
  });

  return authorization;
}

export async function createVapidJwt(options: {
  audience: string;
  subject: string;
  publicKey: string;
  privateKey: string;
  expiresIn?: number;
}): Promise<{ jwt: string; publicKey: string }> {
  const { audience, subject, publicKey, privateKey, expiresIn = 12 * 60 * 60 } = options;

  if (!publicKey) {
    throw new Error('VAPID public key is required');
  }

  if (!privateKey) {
    throw new Error('VAPID private key is required');
  }

  if (!audience) {
    throw new Error('VAPID audience is required');
  }

  if (!subject) {
    throw new Error('VAPID subject is required');
  }

  const normalizedPublicKey = normalizePublicKey(publicKey);
  const privateKeyJwk = normalizePrivateKey(privateKey, normalizedPublicKey);

  const importedPrivateKey = await crypto.subtle.importKey(
    'jwk',
    privateKeyJwk,
    {
      name: 'ECDSA',
      namedCurve: 'P-256',
    },
    false,
    ['sign']
  );

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

  const headerBase64 = base64UrlEncodeString(JSON.stringify(header));
  const payloadBase64 = base64UrlEncodeString(JSON.stringify(payload));
  const unsignedToken = `${headerBase64}.${payloadBase64}`;

  const signature = await crypto.subtle.sign(
    {
      name: 'ECDSA',
      hash: 'SHA-256',
    },
    importedPrivateKey,
    new TextEncoder().encode(unsignedToken)
  );

  const signatureBase64 = bytesToBase64Url(signature);
  const jwt = `${unsignedToken}.${signatureBase64}`;

  return { jwt, publicKey: normalizedPublicKey.base64Url };
}

export async function createVapidHeaders(options: {
  audience: string;
  subject: string;
  publicKey: string;
  privateKey: string;
  expiresIn?: number;
}): Promise<{ authorization: string; cryptoKey: string; jwt: string }> {
  const { jwt, publicKey } = await createVapidJwt(options);

  return {
    authorization: `vapid t=${jwt}, k=${publicKey}`,
    cryptoKey: `p256ecdsa=${publicKey}`,
    jwt,
  };
}

type NormalizedPublicKey = {
  base64Url: string;
  x: string;
  y: string;
};

function normalizePublicKey(publicKey: string): NormalizedPublicKey {
  const trimmedKey = publicKey.trim();
  const parsedJwk = parseJwk(trimmedKey);

  if (parsedJwk?.x && parsedJwk?.y) {
    const rawKey = publicKeyBytesFromJwk(parsedJwk.x, parsedJwk.y);
    return {
      base64Url: bytesToBase64Url(rawKey),
      x: parsedJwk.x,
      y: parsedJwk.y,
    };
  }

  const rawBytes = base64UrlToBytes(trimmedKey);
  if (rawBytes.length !== 65 || rawBytes[0] !== 4) {
    throw new Error('Invalid VAPID public key format');
  }

  const xBytes = rawBytes.slice(1, 33);
  const yBytes = rawBytes.slice(33, 65);

  return {
    base64Url: bytesToBase64Url(rawBytes),
    x: bytesToBase64Url(xBytes),
    y: bytesToBase64Url(yBytes),
  };
}

function normalizePrivateKey(privateKey: string, publicKey: NormalizedPublicKey): JsonWebKey {
  const trimmedKey = privateKey.trim();
  const parsedJwk = parseJwk(trimmedKey);

  if (parsedJwk) {
    const dValue = parsedJwk.d;
    if (!dValue) {
      throw new Error('Invalid VAPID private key format');
    }

    return {
      kty: 'EC',
      crv: 'P-256',
      x: parsedJwk.x ?? publicKey.x,
      y: parsedJwk.y ?? publicKey.y,
      d: dValue,
    };
  }

  const rawPrivateKey = base64UrlToBytes(trimmedKey);
  if (rawPrivateKey.length !== 32) {
    throw new Error('Invalid VAPID private key format');
  }

  return {
    kty: 'EC',
    crv: 'P-256',
    x: publicKey.x,
    y: publicKey.y,
    d: bytesToBase64Url(rawPrivateKey),
  };
}

function parseJwk(value: string): JsonWebKey | null {
  if (value.startsWith('{')) {
    try {
      return JSON.parse(value) as JsonWebKey;
    } catch {
      return null;
    }
  }

  try {
    const decoded = base64UrlDecodeToString(value);
    if (decoded.trim().startsWith('{')) {
      return JSON.parse(decoded) as JsonWebKey;
    }
  } catch {
    return null;
  }

  return null;
}

function publicKeyBytesFromJwk(x: string, y: string): Uint8Array {
  const xBytes = base64UrlToBytes(x);
  const yBytes = base64UrlToBytes(y);
  const publicKeyBytes = new Uint8Array(1 + xBytes.length + yBytes.length);

  publicKeyBytes[0] = 4;
  publicKeyBytes.set(xBytes, 1);
  publicKeyBytes.set(yBytes, 1 + xBytes.length);

  return publicKeyBytes;
}

/**
 * Base64 URL encode
 */
function base64UrlEncode(str: string): string {
  return base64UrlEncodeString(str);
}

/**
 * Base64 URL decode
 */
function base64UrlDecode(str: string): string {
  return base64UrlDecodeToString(str);
}

/**
 * Convert ArrayBuffer to base64url
 */
function arrayBufferToBase64Url(buffer: ArrayBuffer): string {
  return bytesToBase64Url(buffer);
}

function base64UrlEncodeString(str: string): string {
  return bytesToBase64Url(new TextEncoder().encode(str));
}

function base64UrlDecodeToString(str: string): string {
  return new TextDecoder().decode(base64UrlToBytes(str));
}

function base64UrlToBytes(str: string): Uint8Array {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(base64 + padding);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function bytesToBase64Url(input: ArrayBuffer | Uint8Array): string {
  const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : input;
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const base64 = btoa(binary);
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
