/**
 * Tests for Zod validation schemas
 */

import { describe, it, expect } from 'vitest';
import { ClaimTaskSchema, ReleaseTaskSchema, RenewTaskSchema, UpdateStatusSchema } from './queue';
import { DaemonRegistrationSchema, DaemonHeartbeatSchema } from './daemon';
import { ConversationMessageSchema, UserPreferencesSchema } from './memory';
import { CreateTaskSchema, UpdateTaskSchema } from './cron';

describe('Queue Validation Schemas', () => {
  describe('ClaimTaskSchema', () => {
    it('should validate valid claim task input', () => {
      const valid = {
        workerId: 'worker-123',
        leaseDurationSec: 300
      };
      const result = ClaimTaskSchema.safeParse(valid);
      expect(result.success).toBe(true);
    });

    it('should allow optional fields', () => {
      const valid = {};
      const result = ClaimTaskSchema.safeParse(valid);
      expect(result.success).toBe(true);
    });

    it('should reject invalid leaseDurationSec', () => {
      const invalid = {
        leaseDurationSec: 700 // Max is 600
      };
      const result = ClaimTaskSchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });
  });

  describe('RenewTaskSchema', () => {
    it('should require workerId', () => {
      const invalid = {
        extendSec: 300
      };
      const result = RenewTaskSchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });

    it('should validate valid renew input', () => {
      const valid = {
        workerId: 'worker-123',
        extendSec: 300
      };
      const result = RenewTaskSchema.safeParse(valid);
      expect(result.success).toBe(true);
    });
  });
});

describe('Daemon Validation Schemas', () => {
  describe('DaemonRegistrationSchema', () => {
    it('should validate valid daemon registration', () => {
      const valid = {
        daemonId: 'daemon-123',
        version: '1.0.0',
        capabilities: ['task-execution'],
        pollInterval: 5000,
        registeredAt: new Date().toISOString()
      };
      const result = DaemonRegistrationSchema.safeParse(valid);
      expect(result.success).toBe(true);
    });

    it('should reject empty capabilities array', () => {
      const invalid = {
        daemonId: 'daemon-123',
        version: '1.0.0',
        capabilities: [],
        pollInterval: 5000,
        registeredAt: new Date().toISOString()
      };
      const result = DaemonRegistrationSchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });
  });

  describe('DaemonHeartbeatSchema', () => {
    it('should validate valid heartbeat', () => {
      const valid = {
        daemonId: 'daemon-123',
        status: 'healthy',
        tasksProcessed: 10,
        lastHeartbeat: new Date().toISOString()
      };
      const result = DaemonHeartbeatSchema.safeParse(valid);
      expect(result.success).toBe(true);
    });

    it('should reject invalid status', () => {
      const invalid = {
        daemonId: 'daemon-123',
        status: 'unknown',
        tasksProcessed: 10,
        lastHeartbeat: new Date().toISOString()
      };
      const result = DaemonHeartbeatSchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });
  });
});

describe('Memory Validation Schemas', () => {
  describe('ConversationMessageSchema', () => {
    it('should validate valid message', () => {
      const valid = {
        user_id: 'user-123',
        channel: 'slack',
        role: 'user',
        content: 'Hello'
      };
      const result = ConversationMessageSchema.safeParse(valid);
      expect(result.success).toBe(true);
    });

    it('should reject empty content', () => {
      const invalid = {
        user_id: 'user-123',
        channel: 'slack',
        role: 'user',
        content: ''
      };
      const result = ConversationMessageSchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });
  });

  describe('UserPreferencesSchema', () => {
    it('should validate valid preferences', () => {
      const valid = {
        user_id: 'user-123',
        timezone: 'UTC',
        language: 'en'
      };
      const result = UserPreferencesSchema.safeParse(valid);
      expect(result.success).toBe(true);
    });
  });
});

describe('Cron Validation Schemas', () => {
  describe('CreateTaskSchema', () => {
    it('should validate valid cron task', () => {
      const valid = {
        user_id: 'user-123',
        cron_expression: '0 9 * * *',
        task_type: 'reminder',
        task_content: 'Daily reminder'
      };
      const result = CreateTaskSchema.safeParse(valid);
      expect(result.success).toBe(true);
    });

    it('should reject invalid cron expression', () => {
      const invalid = {
        user_id: 'user-123',
        cron_expression: 'invalid cron',
        task_type: 'reminder',
        task_content: 'Daily reminder'
      };
      const result = CreateTaskSchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });
  });
});
