import { describe, expect, it } from 'vitest';

import {
  authenticateAPIKey,
  authenticateBearer,
  constantTimeCompare,
} from '../authenticator';

describe('autopilot/auth/authenticator', () => {
  it('Bearer認証成功', () => {
    const result = authenticateBearer('Bearer valid-token', ['valid-token']);

    expect(result.authenticated).toBe(true);
    expect(result.role).toBe('operator');
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.subject)).toBe(true);
  });

  it('Bearer認証失敗（不正トークン）', () => {
    const result = authenticateBearer('Bearer invalid-token', ['valid-token']);

    expect(result.authenticated).toBe(false);
    expect(result.reason).toBe('invalid Bearer token');
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('APIキー認証成功', () => {
    const result = authenticateAPIKey('api-key-1', ['api-key-1']);

    expect(result.authenticated).toBe(true);
    expect(result.role).toBe('operator');
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('定数時間比較が正しく動作', () => {
    expect(constantTimeCompare('same', 'same')).toBe(true);
    expect(constantTimeCompare('same', 'different')).toBe(false);
    expect(constantTimeCompare('short', 'longer')).toBe(false);
  });
});
