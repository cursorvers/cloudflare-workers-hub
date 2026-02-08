/**
 * Tests for Limitless Poller - Topics Extraction & Cleanup/Retry
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { extractTopics } from './limitless-poller';
import type { Env } from '../types';

// Minimal mock env
const createMockEnv = (aiRunResult?: unknown): Env => {
  const aiMock = aiRunResult !== undefined
    ? { run: vi.fn().mockResolvedValue(aiRunResult) }
    : undefined;

  return {
    AI: aiMock,
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test-key',
    CACHE: {} as KVNamespace,
  } as unknown as Env;
};

describe('extractTopics', () => {
  it('extracts topics from a valid AI response', async () => {
    const env = createMockEnv({ response: '["health", "wellness", "exercise"]' });

    const topics = await extractTopics(env, 'We discussed health and wellness routines including exercise.');

    expect(topics).toEqual(['health', 'wellness', 'exercise']);
    expect(env.AI.run).toHaveBeenCalledWith(
      '@cf/meta/llama-3.2-3b-instruct',
      expect.objectContaining({ max_tokens: 100 })
    );
  });

  it('returns empty array when AI is not available', async () => {
    const env = createMockEnv();
    (env as Record<string, unknown>).AI = undefined;

    const topics = await extractTopics(env, 'Some transcript text');

    expect(topics).toEqual([]);
  });

  it('returns empty array when AI returns non-JSON response', async () => {
    const env = createMockEnv({ response: 'I cannot extract topics from this text.' });

    const topics = await extractTopics(env, 'Some transcript text');

    expect(topics).toEqual([]);
  });

  it('returns empty array when AI returns invalid JSON array', async () => {
    const env = createMockEnv({ response: '[1, 2, 3]' });

    const topics = await extractTopics(env, 'Some transcript text');

    expect(topics).toEqual([]);
  });

  it('limits topics to 5 items', async () => {
    const env = createMockEnv({
      response: '["a", "b", "c", "d", "e", "f", "g"]',
    });

    const topics = await extractTopics(env, 'A long transcript with many topics');

    expect(topics).toHaveLength(5);
    expect(topics).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('handles AI run failure gracefully', async () => {
    const env = createMockEnv({ response: '' });
    (env.AI as { run: ReturnType<typeof vi.fn> }).run = vi.fn().mockRejectedValue(new Error('AI unavailable'));

    const topics = await extractTopics(env, 'Some transcript text');

    expect(topics).toEqual([]);
  });

  it('sanitizes quotes and backslashes in transcript', async () => {
    const env = createMockEnv({ response: '["topic"]' });

    await extractTopics(env, 'He said "hello" and she said \\"goodbye\\"');

    const callArgs = (env.AI.run as ReturnType<typeof vi.fn>).mock.calls[0];
    const prompt = callArgs[1].prompt as string;

    // No double quotes or backslashes in the transcript portion
    expect(prompt).not.toContain('"hello"');
    expect(prompt).not.toContain('\\');
  });

  it('truncates long transcripts to 1000 chars', async () => {
    const env = createMockEnv({ response: '["topic"]' });
    const longTranscript = 'a'.repeat(5000);

    await extractTopics(env, longTranscript);

    const callArgs = (env.AI.run as ReturnType<typeof vi.fn>).mock.calls[0];
    const prompt = callArgs[1].prompt as string;

    // Transcript portion should be truncated
    const transcriptSection = prompt.split("Transcript:\n'")[1]?.split("'\n\nTopics:")[0] || '';
    expect(transcriptSection.length).toBeLessThanOrEqual(1000);
  });

  it('handles string response format (not object)', async () => {
    const env = createMockEnv('["direct", "string", "response"]');

    const topics = await extractTopics(env, 'Some transcript');

    expect(topics).toEqual(['direct', 'string', 'response']);
  });

  it('extracts JSON array from mixed text response', async () => {
    const env = createMockEnv({
      response: 'Here are the topics: ["meeting", "project update"] based on the transcript.',
    });

    const topics = await extractTopics(env, 'We had a meeting about the project update.');

    expect(topics).toEqual(['meeting', 'project update']);
  });
});
