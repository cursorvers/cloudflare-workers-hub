/**
 * Tests for log-sanitizer
 *
 * Testing strategy:
 * 1. Structured JSON logging format
 * 2. Sensitive data masking
 * 3. Log injection prevention
 * 4. Compliance requirements
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sanitize, sanitizeObject, safeLog, maskUserId } from './log-sanitizer';

describe('Structured JSON Logging', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  describe('safeLog.log', () => {
    it('should output valid JSON with timestamp and level', () => {
      safeLog.log('Test message');

      expect(consoleLogSpy).toHaveBeenCalledTimes(1);
      const output = consoleLogSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output);

      expect(parsed).toHaveProperty('timestamp');
      expect(parsed).toHaveProperty('level', 'info');
      expect(parsed).toHaveProperty('message', 'Test message');
      expect(new Date(parsed.timestamp).toISOString()).toBe(parsed.timestamp);
    });

    it('should include context object in JSON output', () => {
      const context = { userId: 'user-123', action: 'login' };
      safeLog.log('User action', context);

      const output = consoleLogSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output);

      expect(parsed.userId).toBe('user-123');
      expect(parsed.action).toBe('login');
    });

    it('should sanitize message content', () => {
      safeLog.log('API key: sk-1234567890abcdefghij');

      const output = consoleLogSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output);

      expect(parsed.message).toContain('sk-***REDACTED***');
      expect(parsed.message).not.toContain('sk-1234567890abcdefghij');
    });

    it('should sanitize context object', () => {
      const context = {
        apiKey: 'sk-1234567890abcdefghij',
        email: 'user@example.com'
      };
      safeLog.log('Test', context);

      const output = consoleLogSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output);

      expect(parsed.apiKey).toBe('***REDACTED***');
      expect(parsed.email).toContain('***@example.com');
    });

    it('should handle empty context', () => {
      safeLog.log('Test message');

      const output = consoleLogSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output);

      expect(parsed.timestamp).toBeDefined();
      expect(parsed.level).toBe('info');
      expect(parsed.message).toBe('Test message');
    });

    it('should handle multiple context fields', () => {
      const context = {
        requestId: 'req-123',
        userId: 'user-456',
        duration: 150,
        success: true
      };
      safeLog.log('Request completed', context);

      const output = consoleLogSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output);

      expect(parsed.requestId).toBe('req-123');
      expect(parsed.userId).toBe('user-456');
      expect(parsed.duration).toBe(150);
      expect(parsed.success).toBe(true);
    });
  });

  describe('safeLog.warn', () => {
    it('should output JSON with level: warn', () => {
      safeLog.warn('Warning message');

      expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
      const output = consoleWarnSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output);

      expect(parsed.level).toBe('warn');
      expect(parsed.message).toBe('Warning message');
    });

    it('should include context in warn logs', () => {
      const context = { retries: 3, maxRetries: 5 };
      safeLog.warn('Retry attempt', context);

      const output = consoleWarnSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output);

      expect(parsed.retries).toBe(3);
      expect(parsed.maxRetries).toBe(5);
    });
  });

  describe('safeLog.error', () => {
    it('should output JSON with level: error', () => {
      safeLog.error('Error occurred');

      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
      const output = consoleErrorSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output);

      expect(parsed.level).toBe('error');
      expect(parsed.message).toBe('Error occurred');
    });

    it('should handle error objects in context', () => {
      const context = {
        error: 'Database connection failed',
        code: 'DB_ERROR'
      };
      safeLog.error('Database error', context);

      const output = consoleErrorSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output);

      expect(parsed.error).toBe('Database connection failed');
      expect(parsed.code).toBe('DB_ERROR');
    });
  });

  describe('Compliance features', () => {
    it('should produce parseable JSON for log aggregation', () => {
      const testCases = [
        { msg: 'Simple message', ctx: {} },
        { msg: 'With context', ctx: { key: 'value' } },
        { msg: 'Special chars: "quotes" and \\backslash', ctx: {} },
      ];

      testCases.forEach(({ msg, ctx }) => {
        safeLog.log(msg, ctx);
        const output = consoleLogSpy.mock.calls[consoleLogSpy.mock.calls.length - 1][0] as string;
        expect(() => JSON.parse(output)).not.toThrow();
      });
    });

    it('should maintain consistent field order', () => {
      safeLog.log('Test', { custom: 'field' });

      const output = consoleLogSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output);
      const keys = Object.keys(parsed);

      expect(keys[0]).toBe('timestamp');
      expect(keys[1]).toBe('level');
      expect(keys[2]).toBe('message');
    });

    it('should handle nested objects in context', () => {
      const context = {
        user: {
          id: 'user-123',
          metadata: {
            role: 'admin'
          }
        }
      };
      safeLog.log('Nested context', context);

      const output = consoleLogSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output);

      expect(parsed.user.id).toBe('user-123');
      expect(parsed.user.metadata.role).toBe('admin');
    });

    it('should handle arrays in context', () => {
      const context = {
        items: [1, 2, 3],
        tags: ['test', 'debug']
      };
      safeLog.log('Array context', context);

      const output = consoleLogSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output);

      expect(parsed.items).toEqual([1, 2, 3]);
      expect(parsed.tags).toEqual(['test', 'debug']);
    });
  });
});

describe('Sensitive data masking (existing tests)', () => {
  describe('sanitize', () => {
    it('should mask OpenAI API keys', () => {
      const input = 'API key is sk-1234567890abcdefghij';
      const output = sanitize(input);
      expect(output).toContain('sk-***REDACTED***');
      expect(output).not.toContain('sk-1234567890abcdefghij');
    });

    it('should mask email addresses', () => {
      const input = 'Contact: user@example.com';
      const output = sanitize(input);
      expect(output).toContain('***@example.com');
      expect(output).not.toContain('user@example.com');
    });

    it('should mask JWT tokens', () => {
      const input = 'Token: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
      const output = sanitize(input);
      expect(output).toContain('***JWT_TOKEN***');
    });

    it('should prevent log injection with CRLF', () => {
      const input = 'Malicious\r\nInjected-Header: value';
      const output = sanitize(input);
      expect(output).toContain('\\r\\n');
      expect(output).not.toContain('\r\n');
    });
  });

  describe('sanitizeObject', () => {
    it('should redact sensitive keys', () => {
      const input = {
        username: 'john',
        password: 'secret123',
        apiKey: 'key-123'
      };
      const output = sanitizeObject(input);

      expect(output.username).toBe('john');
      expect(output.password).toBe('***REDACTED***');
      expect(output.apiKey).toBe('***REDACTED***');
    });

    it('should handle nested objects', () => {
      const input = {
        user: {
          name: 'John',
          credentials: {
            password: 'secret'
          }
        }
      };
      const output = sanitizeObject(input);

      expect(output.user.name).toBe('John');
      expect(output.user.credentials.password).toBe('***REDACTED***');
    });

    it('should prevent infinite recursion', () => {
      const circular: Record<string, unknown> = { a: 1 };
      circular.self = circular;

      const output = sanitizeObject(circular);
      expect(output).toBeDefined();
    });
  });

  describe('maskUserId', () => {
    it('should partially mask user IDs', () => {
      expect(maskUserId('user-123456')).toBe('us***56');
    });

    it('should fully mask short IDs', () => {
      expect(maskUserId('abc')).toBe('***');
    });
  });
});

describe('Edge cases', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
  });

  it('should handle null context', () => {
    safeLog.log('Test', null as unknown as Record<string, unknown>);

    const output = consoleLogSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(output);

    expect(parsed.message).toBe('Test');
  });

  it('should handle undefined context', () => {
    safeLog.log('Test', undefined as unknown as Record<string, unknown>);

    const output = consoleLogSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(output);

    expect(parsed.message).toBe('Test');
  });

  it('should handle very long messages', () => {
    const longMessage = 'A'.repeat(10000);
    safeLog.log(longMessage);

    const output = consoleLogSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(output);

    expect(parsed.message).toBe(longMessage);
  });

  it('should handle special characters in context keys', () => {
    const context = {
      'key-with-dash': 'value1',
      'key_with_underscore': 'value2'
    };
    safeLog.log('Test', context);

    const output = consoleLogSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(output);

    expect(parsed['key-with-dash']).toBe('value1');
    expect(parsed['key_with_underscore']).toBe('value2');
  });
});
