/**
 * AI Provider Abstraction Layer
 *
 * Strategic Advisor Phase 2: Intelligence Layer
 *
 * 複雑度に応じて Workers AI / Claude API を自動選択
 * - 軽量タスク → Workers AI (コスト効率)
 * - 複雑タスク → Claude API (精度優先)
 */

import type { Env } from '../types';
import { safeLog } from '../utils/log-sanitizer';

// =============================================================================
// Constants
// =============================================================================

const COMPLEXITY_THRESHOLD = 0.7;
const MAX_TOKENS_WORKERS_AI = 2048;
const MAX_TOKENS_CLAUDE = 4096;

// =============================================================================
// Types
// =============================================================================

export interface AIProvider {
  name: string;
  analyze(prompt: string, context: string): Promise<AIAnalysisResult>;
  estimateComplexity(task: string): number;
}

export interface AIAnalysisResult {
  content: string;
  provider: string;
  tokensUsed?: number;
  latencyMs?: number;
}

export interface ProviderConfig {
  preferredProvider?: 'workers-ai' | 'claude' | 'auto';
  maxTokens?: number;
  temperature?: number;
}

// =============================================================================
// Workers AI Provider (Cloudflare)
// =============================================================================

class WorkersAIProvider implements AIProvider {
  name = 'workers-ai';
  private env: Env;

  constructor(env: Env) {
    this.env = env;
  }

  async analyze(prompt: string, context: string): Promise<AIAnalysisResult> {
    const startTime = Date.now();

    if (!this.env.AI) {
      throw new Error('Workers AI not available');
    }

    const fullPrompt = context ? `${context}\n\n${prompt}` : prompt;

    try {
      const response = await this.env.AI.run('@cf/meta/llama-3.2-3b-instruct', {
        prompt: fullPrompt,
        max_tokens: MAX_TOKENS_WORKERS_AI,
        temperature: 0.3,
      });

      const content = typeof response === 'string'
        ? response
        : (response as { response?: string }).response || JSON.stringify(response);

      return {
        content,
        provider: this.name,
        latencyMs: Date.now() - startTime,
      };
    } catch (error) {
      safeLog.error('[WorkersAI] Analysis failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  estimateComplexity(task: string): number {
    // 簡易的な複雑度推定
    const factors = {
      length: Math.min(task.length / 1000, 0.3),
      codeBlocks: (task.match(/```/g)?.length || 0) * 0.1,
      technicalTerms: (task.match(/\b(architecture|security|performance|optimization|refactor)\b/gi)?.length || 0) * 0.05,
      questions: (task.match(/\?/g)?.length || 0) * 0.02,
    };

    return Math.min(
      factors.length + factors.codeBlocks + factors.technicalTerms + factors.questions,
      1.0
    );
  }
}

// =============================================================================
// Claude API Provider (Anthropic)
// =============================================================================

class ClaudeAPIProvider implements AIProvider {
  name = 'claude-api';
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async analyze(prompt: string, context: string): Promise<AIAnalysisResult> {
    const startTime = Date.now();

    const fullPrompt = context ? `${context}\n\n${prompt}` : prompt;

    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-3-haiku-20240307',
          max_tokens: MAX_TOKENS_CLAUDE,
          temperature: 0.3,
          messages: [
            {
              role: 'user',
              content: fullPrompt,
            },
          ],
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Claude API error: ${response.status} - ${errorText}`);
      }

      const data = await response.json() as {
        content: Array<{ type: string; text: string }>;
        usage?: { input_tokens: number; output_tokens: number };
      };

      const content = data.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n');

      return {
        content,
        provider: this.name,
        tokensUsed: data.usage ? data.usage.input_tokens + data.usage.output_tokens : undefined,
        latencyMs: Date.now() - startTime,
      };
    } catch (error) {
      safeLog.error('[ClaudeAPI] Analysis failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  estimateComplexity(task: string): number {
    // Claude 用の複雑度推定（Workers AI と同じロジック）
    const factors = {
      length: Math.min(task.length / 1000, 0.3),
      codeBlocks: (task.match(/```/g)?.length || 0) * 0.1,
      technicalTerms: (task.match(/\b(architecture|security|performance|optimization|refactor)\b/gi)?.length || 0) * 0.05,
      questions: (task.match(/\?/g)?.length || 0) * 0.02,
    };

    return Math.min(
      factors.length + factors.codeBlocks + factors.technicalTerms + factors.questions,
      1.0
    );
  }
}

// =============================================================================
// Provider Factory
// =============================================================================

/**
 * 複雑度に応じて適切な AI プロバイダーを選択
 */
export function selectProvider(
  env: Env,
  config?: ProviderConfig
): AIProvider {
  const preferred = config?.preferredProvider || 'auto';

  // 明示的に指定された場合
  if (preferred === 'claude' && env.ANTHROPIC_API_KEY) {
    return new ClaudeAPIProvider(env.ANTHROPIC_API_KEY);
  }

  if (preferred === 'workers-ai' && env.AI) {
    return new WorkersAIProvider(env);
  }

  // auto: Workers AI を優先（コスト効率）
  if (env.AI) {
    return new WorkersAIProvider(env);
  }

  // フォールバック: Claude API
  if (env.ANTHROPIC_API_KEY) {
    return new ClaudeAPIProvider(env.ANTHROPIC_API_KEY);
  }

  throw new Error('No AI provider available');
}

/**
 * 複雑度に基づいて自動選択
 */
export function selectProviderByComplexity(
  task: string,
  env: Env
): AIProvider {
  const workersAI = env.AI ? new WorkersAIProvider(env) : null;
  const claudeAPI = env.ANTHROPIC_API_KEY ? new ClaudeAPIProvider(env.ANTHROPIC_API_KEY) : null;

  if (!workersAI && !claudeAPI) {
    throw new Error('No AI provider available');
  }

  // Workers AI のみ利用可能
  if (!claudeAPI) {
    return workersAI!;
  }

  // Claude API のみ利用可能
  if (!workersAI) {
    return claudeAPI;
  }

  // 両方利用可能: 複雑度で判断
  const complexity = workersAI.estimateComplexity(task);

  safeLog.log('[AIProvider] Complexity estimation', {
    complexity,
    threshold: COMPLEXITY_THRESHOLD,
    selected: complexity > COMPLEXITY_THRESHOLD ? 'claude-api' : 'workers-ai',
  });

  if (complexity > COMPLEXITY_THRESHOLD) {
    return claudeAPI;
  }

  return workersAI;
}

// =============================================================================
// Convenience Functions
// =============================================================================

/**
 * Strategic Advisor 用の分析実行
 */
export async function analyzeWithAI(
  prompt: string,
  context: string,
  env: Env,
  config?: ProviderConfig
): Promise<AIAnalysisResult> {
  const provider = config?.preferredProvider === 'auto'
    ? selectProviderByComplexity(prompt + context, env)
    : selectProvider(env, config);

  safeLog.log('[AIProvider] Running analysis', {
    provider: provider.name,
    promptLength: prompt.length,
    contextLength: context.length,
  });

  return provider.analyze(prompt, context);
}
