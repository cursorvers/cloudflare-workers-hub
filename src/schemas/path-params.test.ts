/**
 * Tests for path parameter validation schemas
 * 
 * SECURITY: These tests verify that path parameters are properly
 * validated to prevent injection attacks.
 */

import { describe, it, expect } from 'vitest';
import { UserIdPathSchema, TaskIdPathSchema, ChannelPathSchema, GenericIdPathSchema } from './path-params';

describe('Path Parameter Validation', () => {
  describe('UserIdPathSchema', () => {
    it('should accept valid user IDs', () => {
      const validIds = [
        'user-123',
        'U01ABC123',
        'user_abc_123',
        'a',
        'A1',
        '123',
        'a'.repeat(64), // max length
      ];

      validIds.forEach(id => {
        const result = UserIdPathSchema.safeParse(id);
        expect(result.success).toBe(true);
      });
    });

    it('should reject invalid user IDs', () => {
      const invalidIds = [
        '', // empty
        'a'.repeat(65), // too long
        'user@example', // invalid char @
        'user.com', // invalid char .
        'user/123', // invalid char /
        'user 123', // space
        'user#123', // invalid char #
        '../etc/passwd', // path traversal attempt
        'user;rm -rf', // command injection attempt
        'user<script>', // XSS attempt
      ];

      invalidIds.forEach(id => {
        const result = UserIdPathSchema.safeParse(id);
        expect(result.success).toBe(false);
      });
    });
  });

  describe('TaskIdPathSchema', () => {
    it('should accept valid task IDs', () => {
      const validIds = [
        'task-123',
        'abc-def-456',
        'T123',
        'a',
        '1',
        'a'.repeat(64), // max length
      ];

      validIds.forEach(id => {
        const result = TaskIdPathSchema.safeParse(id);
        expect(result.success).toBe(true);
      });
    });

    it('should reject invalid task IDs', () => {
      const invalidIds = [
        '', // empty
        'a'.repeat(65), // too long
        'task_123', // underscores not allowed
        'task@123', // invalid char @
        'task.123', // invalid char .
        'task/123', // invalid char /
        'task 123', // space
        '../etc/passwd', // path traversal
        'task;rm', // command injection
      ];

      invalidIds.forEach(id => {
        const result = TaskIdPathSchema.safeParse(id);
        expect(result.success).toBe(false);
      });
    });
  });

  describe('ChannelPathSchema', () => {
    it('should accept valid channel names', () => {
      const validChannels = [
        'slack',
        'discord',
        'line-bot',
        'telegram',
        'a',
        '1',
        'a'.repeat(32), // max length
      ];

      validChannels.forEach(channel => {
        const result = ChannelPathSchema.safeParse(channel);
        expect(result.success).toBe(true);
      });
    });

    it('should reject invalid channel names', () => {
      const invalidChannels = [
        '', // empty
        'a'.repeat(33), // too long
        'Slack', // uppercase not allowed
        'slack_bot', // underscores not allowed
        'slack@discord', // invalid char @
        'slack/discord', // invalid char /
        'slack discord', // space
        '../etc/passwd', // path traversal
      ];

      invalidChannels.forEach(channel => {
        const result = ChannelPathSchema.safeParse(channel);
        expect(result.success).toBe(false);
      });
    });
  });

  describe('GenericIdPathSchema', () => {
    it('should accept valid generic IDs', () => {
      const validIds = [
        'id-123',
        'ID_123',
        'abc-def_ghi',
        'a',
        'A1',
        '123',
        'a'.repeat(64), // max length
      ];

      validIds.forEach(id => {
        const result = GenericIdPathSchema.safeParse(id);
        expect(result.success).toBe(true);
      });
    });

    it('should reject invalid generic IDs', () => {
      const invalidIds = [
        '', // empty
        'a'.repeat(65), // too long
        'id@example', // invalid char @
        'id.com', // invalid char .
        'id/path', // invalid char /
        'id path', // space
        '../etc/passwd', // path traversal
        'id;rm -rf', // command injection
      ];

      invalidIds.forEach(id => {
        const result = GenericIdPathSchema.safeParse(id);
        expect(result.success).toBe(false);
      });
    });
  });

  describe('Security: Path Traversal Prevention', () => {
    it('should block path traversal attempts', () => {
      const pathTraversalAttempts = [
        '../',
        '../../etc/passwd',
        '..\\windows\\system32',
        '%2e%2e%2f', // URL encoded ../
        '....//....//etc/passwd',
      ];

      pathTraversalAttempts.forEach(attempt => {
        expect(UserIdPathSchema.safeParse(attempt).success).toBe(false);
        expect(TaskIdPathSchema.safeParse(attempt).success).toBe(false);
        expect(ChannelPathSchema.safeParse(attempt).success).toBe(false);
        expect(GenericIdPathSchema.safeParse(attempt).success).toBe(false);
      });
    });
  });

  describe('Security: Command Injection Prevention', () => {
    it('should block command injection attempts', () => {
      const commandInjectionAttempts = [
        '; rm -rf /',
        '| cat /etc/passwd',
        '`whoami`',
        '$(whoami)',
        '& del /f /q C:\\*',
      ];

      commandInjectionAttempts.forEach(attempt => {
        expect(UserIdPathSchema.safeParse(attempt).success).toBe(false);
        expect(TaskIdPathSchema.safeParse(attempt).success).toBe(false);
        expect(ChannelPathSchema.safeParse(attempt).success).toBe(false);
        expect(GenericIdPathSchema.safeParse(attempt).success).toBe(false);
      });
    });
  });

  describe('Security: SQL Injection Prevention', () => {
    it('should block SQL injection attempts', () => {
      const sqlInjectionAttempts = [
        "' OR '1'='1",
        "'; DROP TABLE users--",
        "admin'--",
        "1' UNION SELECT * FROM users--",
      ];

      sqlInjectionAttempts.forEach(attempt => {
        expect(UserIdPathSchema.safeParse(attempt).success).toBe(false);
        expect(TaskIdPathSchema.safeParse(attempt).success).toBe(false);
        expect(ChannelPathSchema.safeParse(attempt).success).toBe(false);
        expect(GenericIdPathSchema.safeParse(attempt).success).toBe(false);
      });
    });
  });

  describe('Security: XSS Prevention', () => {
    it('should block XSS attempts', () => {
      const xssAttempts = [
        '<script>alert("XSS")</script>',
        '<img src=x onerror=alert(1)>',
        'javascript:alert(1)',
        '<svg onload=alert(1)>',
      ];

      xssAttempts.forEach(attempt => {
        expect(UserIdPathSchema.safeParse(attempt).success).toBe(false);
        expect(TaskIdPathSchema.safeParse(attempt).success).toBe(false);
        expect(ChannelPathSchema.safeParse(attempt).success).toBe(false);
        expect(GenericIdPathSchema.safeParse(attempt).success).toBe(false);
      });
    });
  });
});
