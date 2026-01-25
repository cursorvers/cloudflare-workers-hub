/**
 * Workers AI Integration
 *
 * Provides lightweight AI responses for simple queries:
 * - Simple query detection
 * - Workers AI invocation
 * - FAQ handling
 */

import { Env, NormalizedEvent } from './types';
import { safeLog } from './utils/log-sanitizer';

// Simple query patterns that Workers AI can handle
const SIMPLE_QUERY_PATTERNS = [
  /^(hi|hello|hey|こんにちは|おはよう)/i,
  /^(what is|what's|define|定義)/i,
  /^(help|ヘルプ|使い方)/i,
];

export function isSimpleQuery(content: string): boolean {
  return SIMPLE_QUERY_PATTERNS.some(pattern => pattern.test(content));
}

export async function handleWithWorkersAI(
  env: Env,
  event: NormalizedEvent
): Promise<string> {
  try {
    // Use type assertion for newer model names not yet in type definitions
    const response = await (env.AI.run as (model: string, input: unknown) => Promise<unknown>)(
      '@cf/meta/llama-3.1-8b-instruct',
      {
        messages: [
          {
            role: 'system',
            content: 'You are a helpful assistant. Keep responses brief and friendly.',
          },
          {
            role: 'user',
            content: event.content,
          },
        ],
        max_tokens: 256,
      }
    );

    return (response as { response: string }).response || 'I could not process your request.';
  } catch (error) {
    safeLog.error('Workers AI error:', { error: String(error) });
    return 'Sorry, I encountered an error processing your request.';
  }
}
