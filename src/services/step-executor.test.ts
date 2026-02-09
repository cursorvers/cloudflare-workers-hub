/**
 * Step Executor - Unit Tests
 */

import { describe, it, expect, vi } from 'vitest';
import { StepExecutor } from './step-executor';
import type { LlmGateway } from './llm-gateway';
import type { RunEvent, StepInput, DriveAction } from './step-executor';

// =============================================================================
// Mock LLM Gateway
// =============================================================================

function createMockLlm(text = 'LLM response'): LlmGateway {
  return {
    generateText: vi.fn().mockResolvedValue({
      text,
      costEvent: { provider: 'anthropic', model: 'test', tokens_in: 100, tokens_out: 50, usd: 0.002 },
    }),
    generateJson: vi.fn(),
  } as unknown as LlmGateway;
}

function createStep(overrides: Partial<StepInput> = {}): StepInput {
  return {
    seq: 1,
    agent: 'sonnet',
    input: { description: 'Test task', data: {} },
    attempts: 1,
    max_attempts: 3,
    idempotency_key: 'test-key',
    ...overrides,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('StepExecutor', () => {
  describe('executeStep', () => {
    it('should execute a sonnet step and return success', async () => {
      const llm = createMockLlm('Step result');
      const events: RunEvent[] = [];
      const executor = new StepExecutor({
        llm,
        onEvent: (e) => events.push(e),
      });

      const result = await executor.executeStep('run-1', createStep());

      expect(result.status).toBe('succeeded');
      expect(result.cost_usd).toBe(0.002);
      expect(result.result).toEqual({ text: 'Step result', model: 'claude-sonnet-4-20250514' });
      expect(events).toHaveLength(2); // step_started + step_completed
      expect(events[0].event).toBe('run:step_started');
      expect(events[1].event).toBe('run:step_completed');
    });

    it('should execute a haiku step', async () => {
      const llm = createMockLlm();
      const executor = new StepExecutor({ llm });

      const result = await executor.executeStep('run-1', createStep({ agent: 'haiku' }));

      expect(result.status).toBe('succeeded');
      const callArgs = (llm.generateText as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(callArgs.model).toBe('claude-haiku-4-20250414');
    });

    it('should succeed for codex agent (openai gpt-5.2)', async () => {
      const llm = createMockLlm();
      const executor = new StepExecutor({ llm });

      const result = await executor.executeStep('run-1', createStep({ agent: 'codex' }));

      expect(result.status).toBe('succeeded');
      expect(result.cost_usd).toBeGreaterThanOrEqual(0);
    });

    it('should succeed for glm agent (workers_ai)', async () => {
      const llm = createMockLlm();
      const executor = new StepExecutor({ llm });

      const result = await executor.executeStep('run-1', createStep({ agent: 'glm' }));

      expect(result.status).toBe('succeeded');
      expect(result.cost_usd).toBeGreaterThanOrEqual(0);
    });

    it('should handle LLM failure gracefully', async () => {
      const llm = {
        generateText: vi.fn().mockRejectedValue(new Error('API timeout')),
        generateJson: vi.fn(),
      } as unknown as LlmGateway;

      const events: RunEvent[] = [];
      const executor = new StepExecutor({
        llm,
        onEvent: (e) => events.push(e),
      });

      const result = await executor.executeStep('run-1', createStep());

      expect(result.status).toBe('failed');
      expect(result.error).toContain('API timeout');
      expect(result.cost_usd).toBe(0);
      expect(events[1].data.status).toBe('failed');
    });

    it('should build prompt from string input', async () => {
      const llm = createMockLlm();
      const executor = new StepExecutor({ llm });

      await executor.executeStep('run-1', createStep({ input: 'plain text input' }));

      const callArgs = (llm.generateText as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(callArgs.messages[1].content).toBe('plain text input');
    });

    it('should build prompt from structured input', async () => {
      const llm = createMockLlm();
      const executor = new StepExecutor({ llm });

      await executor.executeStep('run-1', createStep({
        input: { description: 'Write a test', capability: 'code', data: { lang: 'ts' } },
      }));

      const callArgs = (llm.generateText as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(callArgs.messages[1].content).toContain('Task: Write a test');
      expect(callArgs.messages[1].content).toContain('Capability: code');
    });
  });

  describe('driveLoop', () => {
    it('should execute steps until run_done', async () => {
      const llm = createMockLlm();
      const events: RunEvent[] = [];
      const executor = new StepExecutor({
        llm,
        onEvent: (e) => events.push(e),
      });

      let callCount = 0;
      const reportFn = vi.fn().mockImplementation((): DriveAction => {
        callCount++;
        if (callCount < 2) {
          return {
            action: 'execute_step',
            step: createStep({ seq: 2 }),
          };
        }
        return { action: 'run_done', status: 'succeeded' };
      });

      const firstAction: DriveAction = {
        action: 'execute_step',
        step: createStep({ seq: 1 }),
      };

      await executor.driveLoop('run-1', firstAction, reportFn);

      expect(reportFn).toHaveBeenCalledTimes(2);
      // Events: step_started(1) + step_completed(1) + step_started(2) + step_completed(2) + run:completed
      const completedEvents = events.filter((e) => e.event === 'run:completed');
      expect(completedEvents).toHaveLength(1);
    });

    it('should stop on run_blocked', async () => {
      const llm = createMockLlm();
      const events: RunEvent[] = [];
      const executor = new StepExecutor({
        llm,
        onEvent: (e) => events.push(e),
      });

      const reportFn = vi.fn().mockResolvedValue({
        action: 'run_blocked',
        status: 'blocked_error',
        reason: 'budget_exceeded',
      });

      await executor.driveLoop(
        'run-1',
        { action: 'execute_step', step: createStep() },
        reportFn,
      );

      expect(reportFn).toHaveBeenCalledOnce();
      const blockedEvents = events.filter((e) => e.event === 'run:blocked');
      expect(blockedEvents).toHaveLength(1);
      expect(blockedEvents[0].data.reason).toBe('budget_exceeded');
    });

    it('should handle run_done as first action', async () => {
      const llm = createMockLlm();
      const events: RunEvent[] = [];
      const executor = new StepExecutor({
        llm,
        onEvent: (e) => events.push(e),
      });

      const reportFn = vi.fn();

      await executor.driveLoop(
        'run-1',
        { action: 'run_done', status: 'succeeded' },
        reportFn,
      );

      expect(reportFn).not.toHaveBeenCalled();
      expect(events.some((e) => e.event === 'run:completed')).toBe(true);
    });

    it('should exit on awaiting_step', async () => {
      const llm = createMockLlm();
      const executor = new StepExecutor({ llm });
      const reportFn = vi.fn();

      await executor.driveLoop(
        'run-1',
        { action: 'awaiting_step' },
        reportFn,
      );

      expect(reportFn).not.toHaveBeenCalled();
    });

    it('should respect max iterations', async () => {
      const llm = createMockLlm();
      const events: RunEvent[] = [];
      const executor = new StepExecutor({
        llm,
        onEvent: (e) => events.push(e),
      });

      // Always return execute_step to force max iterations
      const reportFn = vi.fn().mockResolvedValue({
        action: 'execute_step',
        step: createStep(),
      });

      await executor.driveLoop(
        'run-1',
        { action: 'execute_step', step: createStep() },
        reportFn,
      );

      // Should have stopped at MAX_LOOP_ITERATIONS (50)
      expect(reportFn.mock.calls.length).toBeLessThanOrEqual(50);
      const blockedEvents = events.filter((e) => e.event === 'run:blocked');
      expect(blockedEvents.length).toBeGreaterThan(0);
    });
  });
});
