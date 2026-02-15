/**
 * Task Pack Generator - Unit Tests
 */

import { describe, it, expect, vi } from 'vitest';
import {
  TaskPackGenerator,
  createDefaultDelegationMatrix,
  TaskPackError,
} from './task-pack-generator';
import type { LlmGateway } from './llm-gateway';

// =============================================================================
// Mock LLM Gateway
// =============================================================================

function createMockLlm(output: unknown): LlmGateway {
  return {
    generateJson: vi.fn().mockResolvedValue({
      output,
      rawText: JSON.stringify(output),
      costEvent: { provider: 'anthropic', model: 'test', tokens_in: 100, tokens_out: 50, usd: 0.001 },
    }),
    generateText: vi.fn(),
  } as unknown as LlmGateway;
}

// =============================================================================
// Tests
// =============================================================================

describe('TaskPackGenerator', () => {
  describe('generate', () => {
    it('should decompose instruction into steps with agent assignment', async () => {
      const rawOutput = {
        steps: [
          { seq: 1, capability: 'code', description: 'Write function', input: { task: 'write' }, risk: 'low', max_attempts: 3 },
          { seq: 2, capability: 'review', description: 'Review code', input: { task: 'review' }, risk: 'low', max_attempts: 1 },
        ],
        rationale: 'Two-step workflow',
      };

      const llm = createMockLlm(rawOutput);
      const generator = new TaskPackGenerator({
        llm,
        delegation: createDefaultDelegationMatrix(),
      });

      const result = await generator.generate({ instruction: 'Build a feature' });

      expect(result.steps).toHaveLength(2);
      expect(result.steps[0].agent).toBe('sonnet'); // MVP: Sonnet-only
      expect(result.steps[1].agent).toBe('sonnet'); // MVP: Sonnet-only
      expect(result.rationale).toBe('Two-step workflow');
      expect(result.costEvent.usd).toBe(0.001);
    });

    it('should assign sonnet for high-risk security steps', async () => {
      const rawOutput = {
        steps: [
          { seq: 1, capability: 'security', description: 'Audit', input: {}, risk: 'high', max_attempts: 3 },
        ],
      };

      const llm = createMockLlm(rawOutput);
      const generator = new TaskPackGenerator({
        llm,
        delegation: createDefaultDelegationMatrix(),
      });

      const result = await generator.generate({ instruction: 'Security audit' });

      expect(result.steps[0].agent).toBe('sonnet');
    });

    it('should assign haiku for search capability', async () => {
      const rawOutput = {
        steps: [
          { seq: 1, capability: 'search', description: 'Find files', input: {}, risk: 'low', max_attempts: 1 },
        ],
      };

      const llm = createMockLlm(rawOutput);
      const generator = new TaskPackGenerator({
        llm,
        delegation: createDefaultDelegationMatrix(),
      });

      const result = await generator.generate({ instruction: 'Find files' });

      expect(result.steps[0].agent).toBe('sonnet');
    });

    it('should re-number seq starting from 1', async () => {
      const rawOutput = {
        steps: [
          { seq: 5, capability: 'code', description: 'Step A', input: {}, risk: 'low', max_attempts: 3 },
          { seq: 10, capability: 'code', description: 'Step B', input: {}, risk: 'low', max_attempts: 3 },
        ],
      };

      const llm = createMockLlm(rawOutput);
      const generator = new TaskPackGenerator({
        llm,
        delegation: createDefaultDelegationMatrix(),
      });

      const result = await generator.generate({ instruction: 'Do things' });

      expect(result.steps[0].seq).toBe(1);
      expect(result.steps[1].seq).toBe(2);
    });

    it('should truncate steps exceeding maxSteps and add warning', async () => {
      const rawOutput = {
        steps: Array.from({ length: 5 }, (_, i) => ({
          seq: i + 1,
          capability: 'code',
          description: `Step ${i + 1}`,
          input: {},
          risk: 'low' as const,
          max_attempts: 3,
        })),
      };

      const llm = createMockLlm(rawOutput);
      const generator = new TaskPackGenerator({
        llm,
        delegation: createDefaultDelegationMatrix(),
      });

      const result = await generator.generate({ instruction: 'Many steps', maxSteps: 3 });

      expect(result.steps).toHaveLength(3);
      expect(result.warnings).toBeDefined();
      expect(result.warnings![0]).toContain('Truncated');
    });

    it('should throw EMPTY_STEPS when LLM returns empty steps', async () => {
      const llm = createMockLlm({ steps: [] });

      // Override to return the schema-invalid empty array
      (llm.generateJson as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('LLM output did not match schema'),
      );

      const generator = new TaskPackGenerator({
        llm,
        delegation: createDefaultDelegationMatrix(),
      });

      await expect(
        generator.generate({ instruction: 'empty' }),
      ).rejects.toThrow(TaskPackError);
    });

    it('should throw VALIDATION_ERROR for empty instruction', async () => {
      const llm = createMockLlm({ steps: [] });
      const generator = new TaskPackGenerator({
        llm,
        delegation: createDefaultDelegationMatrix(),
      });

      await expect(
        generator.generate({ instruction: '' }),
      ).rejects.toThrow('at least 1 character');
    });

    it('should handle context as object', async () => {
      const rawOutput = {
        steps: [
          { seq: 1, capability: 'code', description: 'Step', input: {}, risk: 'low', max_attempts: 3 },
        ],
      };

      const llm = createMockLlm(rawOutput);
      const generator = new TaskPackGenerator({
        llm,
        delegation: createDefaultDelegationMatrix(),
      });

      const result = await generator.generate({
        instruction: 'With context',
        context: { key: 'value' },
      });

      expect(result.steps).toHaveLength(1);
      // Verify the LLM was called with context in the message
      const callArgs = (llm.generateJson as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(callArgs.messages[1].content).toContain('Context:');
    });
  });

  describe('createDefaultDelegationMatrix', () => {
    const matrix = createDefaultDelegationMatrix();

    it('should map code/low to sonnet', () => {
      expect(matrix.pickAgent({ capability: 'code', risk: 'low' })).toBe('sonnet');
    });

    it('should map code/high to sonnet', () => {
      expect(matrix.pickAgent({ capability: 'code', risk: 'high' })).toBe('sonnet');
    });

    it('should map review/low to sonnet', () => {
      expect(matrix.pickAgent({ capability: 'review', risk: 'low' })).toBe('sonnet');
    });

    it('should map search/low to sonnet', () => {
      expect(matrix.pickAgent({ capability: 'search' })).toBe('sonnet');
    });

    it('should map ui/low to sonnet', () => {
      expect(matrix.pickAgent({ capability: 'ui' })).toBe('sonnet');
    });

    it('should map unknown capability to sonnet (default)', () => {
      expect(matrix.pickAgent({ capability: 'unknown' })).toBe('sonnet');
    });

    it('should map unknown/high to sonnet', () => {
      expect(matrix.pickAgent({ capability: 'unknown', risk: 'high' })).toBe('sonnet');
    });
  });
});
