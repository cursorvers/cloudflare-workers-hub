import { describe, expect, it } from 'vitest';

import {
  REQUIRED_SECRETS,
  maskSecret,
  validateRequiredSecrets,
} from '../secrets-validator';

describe('autopilot/auth/secrets-validator', () => {
  it('全シークレット存在で成功', () => {
    const result = validateRequiredSecrets({
      AUTOPILOT_API_KEY: 'api-key-value',
      AUTOPILOT_WEBHOOK_SECRET: 'webhook-secret-value',
    });

    expect(result.valid).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.empty).toEqual([]);
  });

  it('必須シークレット欠落で失敗（missing配列に含まれる）', () => {
    const result = validateRequiredSecrets({
      AUTOPILOT_API_KEY: 'api-key-value',
    });

    expect(result.valid).toBe(false);
    expect(result.missing).toContain('AUTOPILOT_WEBHOOK_SECRET');
  });

  it('空文字シークレットで失敗（empty配列に含まれる）', () => {
    const result = validateRequiredSecrets({
      AUTOPILOT_API_KEY: '',
      AUTOPILOT_WEBHOOK_SECRET: 'webhook-secret-value',
    });

    expect(result.valid).toBe(false);
    expect(result.empty).toContain('AUTOPILOT_API_KEY');
  });

  it('whitespaceのみシークレットで失敗', () => {
    const result = validateRequiredSecrets({
      AUTOPILOT_API_KEY: '   \t\n',
      AUTOPILOT_WEBHOOK_SECRET: 'webhook-secret-value',
    });

    expect(result.valid).toBe(false);
    expect(result.empty).toContain('AUTOPILOT_API_KEY');
  });

  it('maskSecretが値を適切にマスク', () => {
    expect(maskSecret('abcdef')).toBe('ab****');
    expect(maskSecret('xy')).toBe('xy****');
    expect(maskSecret('z')).toBe('z****');
  });

  it('全結果がObject.freeze', () => {
    expect(Object.isFrozen(REQUIRED_SECRETS)).toBe(true);

    const result = validateRequiredSecrets({
      AUTOPILOT_API_KEY: 'api-key-value',
      AUTOPILOT_WEBHOOK_SECRET: '',
    });

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.missing)).toBe(true);
    expect(Object.isFrozen(result.empty)).toBe(true);
  });
});
