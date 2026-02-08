import { describe, expect, it } from 'vitest';
import { decodeBase64UrlToUint8Array } from './base64url';

function toString(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

describe('base64url', () => {
  it('decodes unpadded base64url', () => {
    // "Hello" -> SGVsbG8= (base64) -> SGVsbG8 (base64url, no padding)
    const bytes = decodeBase64UrlToUint8Array('SGVsbG8');
    expect(toString(bytes)).toBe('Hello');
  });

  it('decodes base64url with - and _', () => {
    // 0xFF 0xEE -> /+4= (base64) -> _-4 (base64url, no padding)
    const bytes = decodeBase64UrlToUint8Array('_-4');
    expect(Array.from(bytes)).toEqual([0xff, 0xee]);
  });
});

