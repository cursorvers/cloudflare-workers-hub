/**
 * LLM Gateway - Unit Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LlmGateway, LlmGatewayError } from './llm-gateway';
import type { Env } from '../types';

// =============================================================================
// Mock fetch
// =============================================================================

const originalFetch = globalThis.fetch;

function mockFetch(response: { ok: boolean; status: number; body: unknown; text?: string }) {
  return vi.fn().mockResolvedValue({
    ok: response.ok,
    status: response.status,
    json: () => Promise.resolve(response.body),
    text: () => Promise.resolve(response.text ?? JSON.stringify(response.body)),
  });
}

function createMockEnv(overrides: Partial<Env> = {}): Env {
  return {
    AI: {
      run: vi.fn().mockResolvedValue({ response: 'Workers AI response' }),
    } as unknown as Ai,
    ANTHROPIC_API_KEY: 'test-anthropic-key',
    OPENAI_API_KEY: 'test-openai-key',
    ENVIRONMENT: 'test',
    ...overrides,
  } as Env;
}

// =============================================================================
// Tests
// =============================================================================

describe('LlmGateway', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('generateText', () => {
    it('should call Anthropic API and return text + cost', async () => {
      globalThis.fetch = mockFetch({
        ok: true,
        status: 200,
        body: {
          content: [{ type: 'text', text: 'Hello from Claude' }],
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      });

      const env = createMockEnv();
      const gateway = new LlmGateway(env);

      const result = await gateway.generateText({
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        messages: [{ role: 'user', content: 'Hello' }],
      });

      expect(result.text).toBe('Hello from Claude');
      expect(result.costEvent.provider).toBe('anthropic');
      expect(result.costEvent.model).toBe('claude-sonnet-4-20250514');
      expect(result.costEvent.tokens_in).toBe(100);
      expect(result.costEvent.tokens_out).toBe(50);
      expect(result.costEvent.usd).toBeGreaterThan(0);
    });

    it('should call Workers AI via env.AI.run', async () => {
      const env = createMockEnv();
      const gateway = new LlmGateway(env);

      const result = await gateway.generateText({
        provider: 'workers_ai',
        model: '@cf/meta/llama-3.1-8b-instruct',
        messages: [{ role: 'user', content: 'Hi' }],
      });

      expect(result.text).toBe('Workers AI response');
      expect(result.costEvent.provider).toBe('workers_ai');
      expect(env.AI.run).toHaveBeenCalledOnce();
    });

    it('should call OpenAI API and return text + cost', async () => {
      globalThis.fetch = mockFetch({
        ok: true,
        status: 200,
        body: {
          choices: [{ message: { content: 'Hello from GPT' } }],
          usage: { prompt_tokens: 80, completion_tokens: 40 },
        },
      });

      const env = createMockEnv();
      const gateway = new LlmGateway(env);

      const result = await gateway.generateText({
        provider: 'openai',
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Hello' }],
      });

      expect(result.text).toBe('Hello from GPT');
      expect(result.costEvent.tokens_in).toBe(80);
      expect(result.costEvent.tokens_out).toBe(40);
    });

    it('should throw PROVIDER_ERROR on Anthropic 4xx', async () => {
      globalThis.fetch = mockFetch({
        ok: false,
        status: 400,
        body: {},
        text: 'Bad request',
      });

      const env = createMockEnv();
      const gateway = new LlmGateway(env);

      await expect(
        gateway.generateText({
          provider: 'anthropic',
          model: 'claude-sonnet-4-20250514',
          messages: [{ role: 'user', content: 'Hello' }],
        }),
      ).rejects.toThrow(LlmGatewayError);
    });

    it('should throw when API key is missing', async () => {
      const env = createMockEnv({ ANTHROPIC_API_KEY: undefined });
      const gateway = new LlmGateway(env);

      await expect(
        gateway.generateText({
          provider: 'anthropic',
          model: 'claude-sonnet-4-20250514',
          messages: [{ role: 'user', content: 'Hello' }],
        }),
      ).rejects.toThrow('ANTHROPIC_API_KEY not configured');
    });

    it('should throw INVALID_RESPONSE when Workers AI returns non-object', async () => {
      const env = createMockEnv({
        AI: { run: vi.fn().mockResolvedValue(null) } as unknown as Ai,
      });
      const gateway = new LlmGateway(env);

      await expect(
        gateway.generateText({
          provider: 'workers_ai',
          model: '@cf/meta/llama-3.1-8b-instruct',
          messages: [{ role: 'user', content: 'Hi' }],
        }),
      ).rejects.toThrow('non-object response');
    });

    it('should validate request with Zod', async () => {
      const env = createMockEnv();
      const gateway = new LlmGateway(env);

      await expect(
        gateway.generateText({
          provider: 'anthropic',
          model: '',
          messages: [],
        }),
      ).rejects.toThrow(LlmGatewayError);
    });
  });

  describe('generateJson', () => {
    it('should parse JSON from LLM output and validate with schema', async () => {
      const { z } = await import('zod');

      globalThis.fetch = mockFetch({
        ok: true,
        status: 200,
        body: {
          content: [{ type: 'text', text: '```json\n{"name": "test", "value": 42}\n```' }],
          usage: { input_tokens: 50, output_tokens: 30 },
        },
      });

      const schema = z.object({ name: z.string(), value: z.number() });
      const env = createMockEnv();
      const gateway = new LlmGateway(env);

      const result = await gateway.generateJson(
        {
          provider: 'anthropic',
          model: 'claude-haiku-4-20250414',
          messages: [{ role: 'user', content: 'Give me JSON' }],
        },
        schema,
      );

      expect(result.output).toEqual({ name: 'test', value: 42 });
      expect(result.rawText).toContain('test');
    });

    it('should extract JSON without code fences', async () => {
      const { z } = await import('zod');

      globalThis.fetch = mockFetch({
        ok: true,
        status: 200,
        body: {
          content: [{ type: 'text', text: 'Here is: {"a": 1} done' }],
          usage: { input_tokens: 10, output_tokens: 10 },
        },
      });

      const schema = z.object({ a: z.number() });
      const env = createMockEnv();
      const gateway = new LlmGateway(env);

      const result = await gateway.generateJson(
        {
          provider: 'anthropic',
          model: 'claude-haiku-4-20250414',
          messages: [{ role: 'user', content: 'JSON please' }],
        },
        schema,
      );

      expect(result.output).toEqual({ a: 1 });
    });

    it('should throw SCHEMA_VIOLATION on invalid JSON structure', async () => {
      const { z } = await import('zod');

      globalThis.fetch = mockFetch({
        ok: true,
        status: 200,
        body: {
          content: [{ type: 'text', text: '{"wrong": true}' }],
          usage: { input_tokens: 10, output_tokens: 10 },
        },
      });

      const schema = z.object({ required_field: z.string() });
      const env = createMockEnv();
      const gateway = new LlmGateway(env);

      await expect(
        gateway.generateJson(
          {
            provider: 'anthropic',
            model: 'claude-haiku-4-20250414',
            messages: [{ role: 'user', content: 'JSON' }],
          },
          schema,
        ),
      ).rejects.toThrow('did not match schema');
    });
  });

  describe('cost calculation', () => {
    it('should calculate Sonnet pricing correctly', async () => {
      globalThis.fetch = mockFetch({
        ok: true,
        status: 200,
        body: {
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
        },
      });

      const env = createMockEnv();
      const gateway = new LlmGateway(env);

      const result = await gateway.generateText({
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        messages: [{ role: 'user', content: 'test' }],
      });

      // Sonnet: $3/MTok in + $15/MTok out = $3 + $15 = $18
      expect(result.costEvent.usd).toBe(18);
    });

    it('should calculate Haiku pricing correctly', async () => {
      globalThis.fetch = mockFetch({
        ok: true,
        status: 200,
        body: {
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
        },
      });

      const env = createMockEnv();
      const gateway = new LlmGateway(env);

      const result = await gateway.generateText({
        provider: 'anthropic',
        model: 'claude-haiku-4-20250414',
        messages: [{ role: 'user', content: 'test' }],
      });

      // Haiku: $0.25/MTok in + $1.25/MTok out = $0.25 + $1.25 = $1.50
      expect(result.costEvent.usd).toBe(1.5);
    });
  });
});
