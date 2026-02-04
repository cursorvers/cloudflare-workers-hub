import { spawn } from 'child_process';
import { z } from 'zod';

/**
 * タスク定義スキーマ
 */
export const TaskSchema = z.object({
  id: z.string(),
  type: z.enum(['git', 'claude-code', 'codex', 'bash']),
  command: z.string(),
  args: z.array(z.string()).optional(),
  workingDir: z.string().optional(),
  timeout: z.number().optional(),
});

export type Task = z.infer<typeof TaskSchema>;

// =============================================================================
// Security Constants (Command Injection Prevention)
// =============================================================================

/**
 * Allowlist of permitted commands
 * Only these commands can be executed via bash type
 */
const ALLOWED_COMMANDS = [
  'git', 'ls', 'pwd', 'cat', 'head', 'tail',
  'npm', 'npx', 'node', 'pnpm', 'bun', 'claude', 'codex',
  'wrangler', 'vitest', 'jest', 'tsc', 'eslint', 'prettier',
] as const;

/**
 * Dangerous patterns that indicate potential command injection
 * - Shell metacharacters: ; | & $ `
 * - Newlines: \n \r
 * - Path traversal: ..
 */
const DANGEROUS_PATTERNS = /[;|&$`\n\r]|(\.\.)/;

/**
 * タスク実行結果
 */
export const TaskResultSchema = z.object({
  id: z.string(),
  success: z.boolean(),
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number().nullable(),
  error: z.string().optional(),
  startTime: z.string(),
  endTime: z.string(),
  duration: z.number(),
});

export type TaskResult = z.infer<typeof TaskResultSchema>;

/**
 * タスク実行エンジン
 */
export class TaskExecutor {
  private runningTasks: Map<string, NodeJS.Timeout> = new Map();

  /**
   * Validate command against security policies
   * @throws Error if command is not allowed or contains dangerous patterns
   */
  private validateCommand(command: string, args: string[]): void {
    // Check if command is in allowlist
    if (!ALLOWED_COMMANDS.includes(command as typeof ALLOWED_COMMANDS[number])) {
      throw new Error(`[Security] Command "${command}" is not in the allowlist`);
    }

    // Check command itself for dangerous patterns
    if (DANGEROUS_PATTERNS.test(command)) {
      throw new Error(`[Security] Command contains dangerous patterns`);
    }

    // Check all arguments for dangerous patterns
    for (const arg of args) {
      if (DANGEROUS_PATTERNS.test(arg)) {
        throw new Error(`[Security] Argument "${arg}" contains dangerous patterns`);
      }
    }
  }

  /**
   * タスクを実行
   */
  async execute(task: Task): Promise<TaskResult> {
    const startTime = new Date();
    const startTimeISO = startTime.toISOString();

    try {
      // タスクのバリデーション
      const validatedTask = TaskSchema.parse(task);

      // タスクタイプに応じた実行
      let result: Omit<TaskResult, 'startTime' | 'endTime' | 'duration'>;

      switch (validatedTask.type) {
        case 'bash':
          result = await this.executeBash(validatedTask);
          break;
        case 'git':
          result = await this.executeGit(validatedTask);
          break;
        case 'claude-code':
          result = await this.executeClaudeCode(validatedTask);
          break;
        case 'codex':
          result = await this.executeCodex(validatedTask);
          break;
        default:
          throw new Error(`未対応のタスクタイプ: ${validatedTask.type}`);
      }

      const endTime = new Date();
      const duration = endTime.getTime() - startTime.getTime();

      return {
        ...result,
        startTime: startTimeISO,
        endTime: endTime.toISOString(),
        duration,
      };
    } catch (error) {
      const endTime = new Date();
      const duration = endTime.getTime() - startTime.getTime();

      return {
        id: task.id,
        success: false,
        stdout: '',
        stderr: '',
        exitCode: null,
        error: error instanceof Error ? error.message : 'Unknown error',
        startTime: startTimeISO,
        endTime: endTime.toISOString(),
        duration,
      };
    }
  }

  /**
   * Bash コマンドを実行
   * SECURITY: shell:false + allowlist + dangerous pattern detection
   */
  private async executeBash(task: Task): Promise<Omit<TaskResult, 'startTime' | 'endTime' | 'duration'>> {
    return new Promise((resolve) => {
      const args = task.args || [];

      // Security validation before execution
      try {
        this.validateCommand(task.command, args);
      } catch (error) {
        return resolve({
          id: task.id,
          success: false,
          stdout: '',
          stderr: '',
          exitCode: null,
          error: error instanceof Error ? error.message : 'Command validation failed',
        });
      }

      // CRITICAL: shell:false prevents command injection
      const proc = spawn(task.command, args, {
        cwd: task.workingDir,
        shell: false,
      });

      let stdout = '';
      let stderr = '';

      proc.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      // タイムアウト設定
      if (task.timeout) {
        const timeoutId = setTimeout(() => {
          proc.kill('SIGTERM');
          this.runningTasks.delete(task.id);
        }, task.timeout);
        this.runningTasks.set(task.id, timeoutId);
      }

      proc.on('close', (code) => {
        if (task.timeout) {
          const timeoutId = this.runningTasks.get(task.id);
          if (timeoutId) {
            clearTimeout(timeoutId);
            this.runningTasks.delete(task.id);
          }
        }

        resolve({
          id: task.id,
          success: code === 0,
          stdout,
          stderr,
          exitCode: code,
        });
      });

      proc.on('error', (error) => {
        resolve({
          id: task.id,
          success: false,
          stdout,
          stderr,
          exitCode: null,
          error: error.message,
        });
      });
    });
  }

  /**
   * Git コマンドを実行
   */
  private async executeGit(task: Task): Promise<Omit<TaskResult, 'startTime' | 'endTime' | 'duration'>> {
    const gitTask = {
      ...task,
      command: 'git',
      args: [task.command, ...(task.args || [])],
    };
    return this.executeBash(gitTask);
  }

  /**
   * Claude Code コマンドを実行（プレースホルダー）
   */
  private async executeClaudeCode(task: Task): Promise<Omit<TaskResult, 'startTime' | 'endTime' | 'duration'>> {
    // TODO: Claude Code の実行ロジックを実装
    return {
      id: task.id,
      success: false,
      stdout: '',
      stderr: 'Claude Code execution not implemented yet',
      exitCode: null,
      error: 'Not implemented',
    };
  }

  /**
   * Codex コマンドを実行（プレースホルダー）
   */
  private async executeCodex(task: Task): Promise<Omit<TaskResult, 'startTime' | 'endTime' | 'duration'>> {
    // TODO: Codex の実行ロジックを実装
    return {
      id: task.id,
      success: false,
      stdout: '',
      stderr: 'Codex execution not implemented yet',
      exitCode: null,
      error: 'Not implemented',
    };
  }

  /**
   * タスクをキャンセル
   */
  cancel(taskId: string): boolean {
    const timeoutId = this.runningTasks.get(taskId);
    if (timeoutId) {
      clearTimeout(timeoutId);
      this.runningTasks.delete(taskId);
      return true;
    }
    return false;
  }

  /**
   * 実行中のタスク一覧を取得
   */
  getRunningTasks(): string[] {
    return Array.from(this.runningTasks.keys());
  }
}
