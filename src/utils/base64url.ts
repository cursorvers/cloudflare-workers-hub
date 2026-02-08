function atobCompat(base64: string): string {
  if (typeof atob === 'function') return atob(base64);
  // Node fallback for tests/local tooling; workerd provides atob().
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const buf = (globalThis as any).Buffer?.from?.(base64, 'base64');
  if (!buf) throw new Error('Base64 decode failed: atob() and Buffer are unavailable');
  return buf.toString('binary');
}

/**
 * Decode base64url (RFC 4648) string to bytes.
 * Some APIs (e.g., Gmail) omit `=` padding; we add it back.
 */
export function decodeBase64UrlToUint8Array(base64url: string): Uint8Array {
  let base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const pad = base64.length % 4;
  if (pad !== 0) base64 += '='.repeat(4 - pad);

  const binaryString = atobCompat(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

