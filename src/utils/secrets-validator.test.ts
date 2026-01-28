/**
 * Tests for Secrets Validator
 *
 * Tests covering:
 * - Individual secret pattern validation
 * - Security pair detection (token without signing secret)
 * - Startup check behavior (strict vs. non-strict mode)
 * - Configured secrets tracking
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { validateSecrets, performStartupCheck } from './secrets-validator';

// Mock log-sanitizer
vi.mock('./log-sanitizer', () => ({
  safeLog: {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { safeLog } from './log-sanitizer';
const mockedSafeLog = vi.mocked(safeLog);

// Helper: create minimal Env
function createEnv(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    AI: {},
    ENVIRONMENT: 'test',
    ...overrides,
  } as any;
}

describe('Secrets Validator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ==========================================================================
  // validateSecrets
  // ==========================================================================
  describe('validateSecrets', () => {
    it('should return valid with no secrets configured', () => {
      const env = createEnv({});
      const result = validateSecrets(env);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.configured).toHaveLength(0);
    });

    it('should track configured secrets', () => {
      const env = createEnv({
        SLACK_BOT_TOKEN: 'xoxb-123456789-123456789-abcdefghijklmnop',
        DISCORD_BOT_TOKEN: 'some-discord-token',
      });
      const result = validateSecrets(env);

      expect(result.configured).toContain('SLACK_BOT_TOKEN');
      expect(result.configured).toContain('DISCORD_BOT_TOKEN');
    });

    // Pattern validation
    describe('pattern validation', () => {
      it('should accept valid Slack Bot Token format', () => {
        const env = createEnv({
          SLACK_BOT_TOKEN: 'xoxb-123456789-987654321-abcdefABCDEF123456',
        });
        const result = validateSecrets(env);

        // Only check pattern validation warnings (not security pair warnings)
        expect(
          result.warnings.filter((w) => w.includes('SLACK_BOT_TOKEN') && w.includes('format'))
        ).toHaveLength(0);
        expect(result.configured).toContain('SLACK_BOT_TOKEN');
      });

      it('should warn on invalid Slack Bot Token format', () => {
        const env = createEnv({
          SLACK_BOT_TOKEN: 'invalid-slack-token',
        });
        const result = validateSecrets(env);

        expect(result.warnings.some((w) => w.includes('SLACK_BOT_TOKEN'))).toBe(true);
      });

      it('should accept valid Slack Signing Secret format', () => {
        const env = createEnv({
          SLACK_SIGNING_SECRET: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4',
        });
        const result = validateSecrets(env);

        expect(result.warnings.filter((w) => w.includes('SLACK_SIGNING_SECRET'))).toHaveLength(0);
      });

      it('should warn on invalid Slack Signing Secret format', () => {
        const env = createEnv({
          SLACK_SIGNING_SECRET: 'too-short',
        });
        const result = validateSecrets(env);

        expect(result.warnings.some((w) => w.includes('SLACK_SIGNING_SECRET'))).toBe(true);
      });

      it('should accept valid Discord Public Key (64 hex chars)', () => {
        const env = createEnv({
          DISCORD_PUBLIC_KEY: 'a'.repeat(64),
        });
        const result = validateSecrets(env);

        expect(result.warnings.filter((w) => w.includes('DISCORD_PUBLIC_KEY'))).toHaveLength(0);
      });

      it('should warn on invalid Discord Public Key format', () => {
        const env = createEnv({
          DISCORD_PUBLIC_KEY: 'not-64-hex-chars',
        });
        const result = validateSecrets(env);

        expect(result.warnings.some((w) => w.includes('DISCORD_PUBLIC_KEY'))).toBe(true);
      });

      it('should accept valid Telegram Bot Token format', () => {
        const env = createEnv({
          TELEGRAM_BOT_TOKEN: '1234567890:ABCDefgh_ijklmnopqrstuvwxyz1234567',
        });
        const result = validateSecrets(env);

        expect(
          result.warnings.filter((w) => w.includes('TELEGRAM_BOT_TOKEN') && w.includes('format'))
        ).toHaveLength(0);
      });

      it('should warn on invalid Telegram Bot Token format', () => {
        const env = createEnv({
          TELEGRAM_BOT_TOKEN: 'invalid-telegram-token',
        });
        const result = validateSecrets(env);

        expect(result.warnings.some((w) => w.includes('TELEGRAM_BOT_TOKEN'))).toBe(true);
      });

      it('should accept valid WhatsApp Phone Number ID (digits only)', () => {
        const env = createEnv({
          WHATSAPP_PHONE_NUMBER_ID: '1234567890',
        });
        const result = validateSecrets(env);

        expect(
          result.warnings.filter((w) => w.includes('WHATSAPP_PHONE_NUMBER_ID'))
        ).toHaveLength(0);
      });

      it('should warn on invalid WhatsApp Phone Number ID', () => {
        const env = createEnv({
          WHATSAPP_PHONE_NUMBER_ID: 'not-a-number',
        });
        const result = validateSecrets(env);

        expect(result.warnings.some((w) => w.includes('WHATSAPP_PHONE_NUMBER_ID'))).toBe(true);
      });

      it('should accept valid WhatsApp App Secret (32 hex chars)', () => {
        const env = createEnv({
          WHATSAPP_APP_SECRET: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4',
        });
        const result = validateSecrets(env);

        expect(result.warnings.filter((w) => w.includes('WHATSAPP_APP_SECRET'))).toHaveLength(0);
      });

      it('should accept valid Sentry DSN format', () => {
        const env = createEnv({
          SENTRY_DSN: 'https://abc123@o123456.ingest.sentry.io/1234567',
        });
        const result = validateSecrets(env);

        expect(result.warnings.filter((w) => w.includes('SENTRY_DSN'))).toHaveLength(0);
      });

      it('should warn on invalid Sentry DSN format', () => {
        const env = createEnv({
          SENTRY_DSN: 'not-a-valid-dsn',
        });
        const result = validateSecrets(env);

        expect(result.warnings.some((w) => w.includes('SENTRY_DSN'))).toBe(true);
      });
    });

    // Security pair validation
    describe('security pair validation', () => {
      it('should warn when Slack token exists without signing secret', () => {
        const env = createEnv({
          SLACK_BOT_TOKEN: 'xoxb-123456789-987654321-abcdefABCDEF123456',
        });
        const result = validateSecrets(env);

        expect(result.warnings.some((w) => w.includes('SLACK_SIGNING_SECRET'))).toBe(true);
      });

      it('should not warn when both Slack token and signing secret exist', () => {
        const env = createEnv({
          SLACK_BOT_TOKEN: 'xoxb-123456789-987654321-abcdefABCDEF123456',
          SLACK_SIGNING_SECRET: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4',
        });
        const result = validateSecrets(env);

        expect(
          result.warnings.filter((w) => w.includes('SLACK_SIGNING_SECRET is missing'))
        ).toHaveLength(0);
      });

      it('should warn when Discord token exists without public key', () => {
        const env = createEnv({
          DISCORD_BOT_TOKEN: 'discord-bot-token',
        });
        const result = validateSecrets(env);

        expect(result.warnings.some((w) => w.includes('DISCORD_PUBLIC_KEY is missing'))).toBe(
          true
        );
      });

      it('should warn when Telegram token exists without secret token', () => {
        const env = createEnv({
          TELEGRAM_BOT_TOKEN: '1234567890:ABCDefgh_ijklmnopqrstuvwxyz1234567',
        });
        const result = validateSecrets(env);

        expect(
          result.warnings.some((w) => w.includes('TELEGRAM_SECRET_TOKEN is missing'))
        ).toBe(true);
      });

      it('should warn when WhatsApp token exists without app secret', () => {
        const env = createEnv({
          WHATSAPP_ACCESS_TOKEN: 'whatsapp-access-token',
        });
        const result = validateSecrets(env);

        expect(
          result.warnings.some((w) => w.includes('WHATSAPP_APP_SECRET is missing'))
        ).toBe(true);
      });

      it('should not warn when no tokens are configured', () => {
        const env = createEnv({});
        const result = validateSecrets(env);

        const securityPairWarnings = result.warnings.filter(
          (w) => w.includes('is missing') && w.includes('verification')
        );
        expect(securityPairWarnings).toHaveLength(0);
      });
    });
  });

  // ==========================================================================
  // performStartupCheck
  // ==========================================================================
  describe('performStartupCheck', () => {
    it('should log configured secrets', () => {
      const env = createEnv({
        DISCORD_BOT_TOKEN: 'some-token',
        DISCORD_PUBLIC_KEY: 'a'.repeat(64),
      });

      performStartupCheck(env);

      expect(mockedSafeLog.log).toHaveBeenCalledWith(
        expect.stringContaining('Configured:')
      );
    });

    it('should log warnings for security pair violations', () => {
      const env = createEnv({
        SLACK_BOT_TOKEN: 'xoxb-123456789-987654321-abcdefABCDEF123456',
      });

      performStartupCheck(env);

      expect(mockedSafeLog.warn).toHaveBeenCalled();
    });

    it('should not throw in non-strict mode even with errors', () => {
      const env = createEnv({});

      expect(() => performStartupCheck(env, false)).not.toThrow();
    });

    it('should not throw when no errors exist', () => {
      const env = createEnv({});

      expect(() => performStartupCheck(env, true)).not.toThrow();
    });

    it('should complete without error for clean configuration', () => {
      const env = createEnv({
        SLACK_BOT_TOKEN: 'xoxb-123456789-987654321-abcdefABCDEF123456',
        SLACK_SIGNING_SECRET: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4',
        DISCORD_BOT_TOKEN: 'discord-token',
        DISCORD_PUBLIC_KEY: 'a'.repeat(64),
      });

      expect(() => performStartupCheck(env)).not.toThrow();
    });
  });
});
