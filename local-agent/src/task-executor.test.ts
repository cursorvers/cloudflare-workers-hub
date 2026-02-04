import { describe, it, expect, vi, beforeEach } from 'vitest';
import { spawn } from 'child_process';
import { TaskExecutor, Task } from './task-executor';

// Mock child_process to verify shell options and prevent actual execution
vi.mock('child_process', () => ({
  spawn: vi.fn(() => ({
    stdout: {
      on: vi.fn(),
    },
    stderr: {
      on: vi.fn(),
    },
    on: vi.fn((event, callback) => {
      if (event === 'close') {
        // Simulate immediate close with exit code 0
        setTimeout(() => callback(0), 10);
      }
    }),
    kill: vi.fn(),
  })),
}));

const spawnMock = vi.mocked(spawn);

describe('TaskExecutor Security Tests', () => {
  let executor: TaskExecutor;

  beforeEach(() => {
    executor = new TaskExecutor();
    vi.clearAllMocks();
  });

  describe('validateCommand() - Allowlist Enforcement', () => {
    it('should allow commands present in the ALLOWED_COMMANDS list', async () => {
      const task: Task = {
        id: 'test-1',
        type: 'bash',
        command: 'git',
        args: ['status'],
      };

      await executor.execute(task);
      expect(spawnMock).toHaveBeenCalledWith('git', ['status'], expect.objectContaining({
        shell: false,
      }));
    });

    it('should allow ls command', async () => {
      const task: Task = {
        id: 'test-2',
        type: 'bash',
        command: 'ls',
        args: ['-la'],
      };

      await executor.execute(task);
      expect(spawnMock).toHaveBeenCalledWith('ls', ['-la'], expect.objectContaining({
        shell: false,
      }));
    });

    it('should reject rm command (not in allowlist)', async () => {
      const task: Task = {
        id: 'test-3',
        type: 'bash',
        command: 'rm',
        args: ['-rf', '/'],
      };

      const result = await executor.execute(task);
      expect(result.success).toBe(false);
      expect(result.error).toContain('[Security] Command "rm" is not in the allowlist');
      expect(spawnMock).not.toHaveBeenCalled();
    });

    it('should reject sudo command (not in allowlist)', async () => {
      const task: Task = {
        id: 'test-4',
        type: 'bash',
        command: 'sudo',
        args: ['ls'],
      };

      const result = await executor.execute(task);
      expect(result.success).toBe(false);
      expect(result.error).toContain('[Security] Command "sudo" is not in the allowlist');
      expect(spawnMock).not.toHaveBeenCalled();
    });

    it('should reject curl command (not in allowlist)', async () => {
      const task: Task = {
        id: 'test-5',
        type: 'bash',
        command: 'curl',
        args: ['http://malicious.com'],
      };

      const result = await executor.execute(task);
      expect(result.success).toBe(false);
      expect(result.error).toContain('[Security] Command "curl" is not in the allowlist');
      expect(spawnMock).not.toHaveBeenCalled();
    });
  });

  describe('validateCommand() - Dangerous Patterns Detection', () => {
    it('should reject commands with semicolon (command chaining)', async () => {
      const task: Task = {
        id: 'test-6',
        type: 'bash',
        command: 'git',
        args: ['log; rm -rf /'],
      };

      const result = await executor.execute(task);
      expect(result.success).toBe(false);
      expect(result.error).toContain('[Security] Argument');
      expect(result.error).toContain('contains dangerous patterns');
      expect(spawnMock).not.toHaveBeenCalled();
    });

    it('should reject arguments with pipe (|)', async () => {
      const task: Task = {
        id: 'test-7',
        type: 'bash',
        command: 'git',
        args: ['log | cat /etc/passwd'],
      };

      const result = await executor.execute(task);
      expect(result.success).toBe(false);
      expect(result.error).toContain('dangerous patterns');
      expect(spawnMock).not.toHaveBeenCalled();
    });

    it('should reject arguments with ampersand (&)', async () => {
      const task: Task = {
        id: 'test-8',
        type: 'bash',
        command: 'npm',
        args: ['install & rm -rf /'],
      };

      const result = await executor.execute(task);
      expect(result.success).toBe(false);
      expect(result.error).toContain('dangerous patterns');
      expect(spawnMock).not.toHaveBeenCalled();
    });

    it('should reject arguments with dollar sign (variable expansion)', async () => {
      const task: Task = {
        id: 'test-9',
        type: 'bash',
        command: 'git',
        args: ['$(whoami)'],
      };

      const result = await executor.execute(task);
      expect(result.success).toBe(false);
      expect(result.error).toContain('dangerous patterns');
      expect(spawnMock).not.toHaveBeenCalled();
    });

    it('should reject arguments with backtick (command substitution)', async () => {
      const task: Task = {
        id: 'test-10',
        type: 'bash',
        command: 'git',
        args: ['`whoami`'],
      };

      const result = await executor.execute(task);
      expect(result.success).toBe(false);
      expect(result.error).toContain('dangerous patterns');
      expect(spawnMock).not.toHaveBeenCalled();
    });

    it('should reject arguments with path traversal (..)', async () => {
      const task: Task = {
        id: 'test-11',
        type: 'bash',
        command: 'cat',
        args: ['../../etc/passwd'],
      };

      const result = await executor.execute(task);
      expect(result.success).toBe(false);
      expect(result.error).toContain('dangerous patterns');
      expect(spawnMock).not.toHaveBeenCalled();
    });

    it('should reject arguments with newline (command injection)', async () => {
      const task: Task = {
        id: 'test-12',
        type: 'bash',
        command: 'ls',
        args: ['-la\nrm -rf /'],
      };

      const result = await executor.execute(task);
      expect(result.success).toBe(false);
      expect(result.error).toContain('dangerous patterns');
      expect(spawnMock).not.toHaveBeenCalled();
    });
  });

  describe('executeBash() - shell:false enforcement', () => {
    it('should call spawn with shell: false', async () => {
      const task: Task = {
        id: 'test-13',
        type: 'bash',
        command: 'npm',
        args: ['install'],
      };

      await executor.execute(task);

      expect(spawnMock).toHaveBeenCalledWith(
        'npm',
        ['install'],
        expect.objectContaining({
          shell: false,
        })
      );
    });

    it('should accept valid git commands', async () => {
      const task: Task = {
        id: 'test-14',
        type: 'bash',
        command: 'git',
        args: ['commit', '-m', 'feat: add feature'],
      };

      await executor.execute(task);
      expect(spawnMock).toHaveBeenCalled();
    });

    it('should accept valid npm commands', async () => {
      const task: Task = {
        id: 'test-15',
        type: 'bash',
        command: 'npm',
        args: ['install', '--save-dev', 'vitest'],
      };

      await executor.execute(task);
      expect(spawnMock).toHaveBeenCalled();
    });
  });

  describe('Git task type', () => {
    it('should handle git task type', async () => {
      const task: Task = {
        id: 'test-16',
        type: 'git',
        command: 'status',
      };

      await executor.execute(task);
      expect(spawnMock).toHaveBeenCalledWith(
        'git',
        ['status'],
        expect.objectContaining({
          shell: false,
        })
      );
    });
  });

  describe('Timeout handling', () => {
    it('should respect timeout setting', async () => {
      const task: Task = {
        id: 'test-17',
        type: 'bash',
        command: 'npm',
        args: ['install'],
        timeout: 5000,
      };

      await executor.execute(task);
      expect(spawnMock).toHaveBeenCalled();
    });
  });

  describe('claude-code task type', () => {
    it('should return not implemented for claude-code tasks', async () => {
      const task: Task = {
        id: 'test-18',
        type: 'claude-code',
        command: 'help',
      };

      const result = await executor.execute(task);
      expect(result.success).toBe(false);
      expect(result.error).toBe('Not implemented');
      expect(result.stderr).toContain('Claude Code execution not implemented');
    });
  });

  describe('codex task type', () => {
    it('should return not implemented for codex tasks', async () => {
      const task: Task = {
        id: 'test-19',
        type: 'codex',
        command: 'analyze',
      };

      const result = await executor.execute(task);
      expect(result.success).toBe(false);
      expect(result.error).toBe('Not implemented');
      expect(result.stderr).toContain('Codex execution not implemented');
    });
  });

  describe('cancel() and getRunningTasks()', () => {
    it('should return false when cancelling non-existent task', () => {
      const cancelled = executor.cancel('non-existent-task');
      expect(cancelled).toBe(false);
    });

    it('should return empty array when no tasks are running', () => {
      const tasks = executor.getRunningTasks();
      expect(tasks).toEqual([]);
    });

    it('should cancel a running task with timeout', async () => {
      // Mock spawn to simulate a long-running process
      let closeCallback: ((code: number | null) => void) | null = null;
      spawnMock.mockImplementation(() => {
        const mockProc = {
          stdout: { on: vi.fn() },
          stderr: { on: vi.fn() },
          on: vi.fn((event, callback) => {
            if (event === 'close') {
              closeCallback = callback;
            }
          }),
          kill: vi.fn(),
        };
        return mockProc as any;
      });

      const task: Task = {
        id: 'test-cancel',
        type: 'bash',
        command: 'npm',
        args: ['install'],
        timeout: 60000, // Long timeout
      };

      // Start execution (won't complete immediately)
      const promise = executor.execute(task);

      // Wait a tick for the task to register
      await new Promise(resolve => setTimeout(resolve, 20));

      // Task should be in running tasks
      expect(executor.getRunningTasks()).toContain('test-cancel');

      // Cancel the task
      const cancelled = executor.cancel('test-cancel');
      expect(cancelled).toBe(true);

      // Task should be removed from running tasks
      expect(executor.getRunningTasks()).not.toContain('test-cancel');

      // Simulate process close to resolve the promise
      if (closeCallback) {
        closeCallback(0);
      }

      await promise;
    });
  });

  describe('Error handling', () => {
    it('should handle spawn errors gracefully', async () => {
      // Mock spawn to emit error
      spawnMock.mockImplementation(() => {
        const mockProc = {
          stdout: { on: vi.fn() },
          stderr: { on: vi.fn() },
          on: vi.fn((event, callback) => {
            if (event === 'error') {
              setTimeout(() => callback(new Error('spawn ENOENT')), 10);
            }
          }),
          kill: vi.fn(),
        };
        return mockProc as any;
      });

      const task: Task = {
        id: 'test-20',
        type: 'bash',
        command: 'node',
        args: ['--version'],
      };

      const result = await executor.execute(task);
      expect(result.success).toBe(false);
      expect(result.error).toBe('spawn ENOENT');
    });
  });

  describe('Zod validation', () => {
    it('should reject invalid task schema', async () => {
      const invalidTask = {
        id: 'test-21',
        type: 'invalid-type', // Invalid type
        command: 'ls',
      };

      const result = await executor.execute(invalidTask as Task);
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });
});
