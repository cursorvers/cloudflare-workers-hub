/**
 * Lazy Loader for Context Optimization
 *
 * タスクに必要なルールファイルのみをロードし、
 * コンテキストウィンドウの使用量を最小化する。
 *
 * 目標: 66% のコンテキスト削減
 */

import { SkillHint } from '../adapters/commhub';

export interface LoadedRule {
  category: string;
  file: string;
  content: string;
  tokens: number;
}

export interface LazyLoadResult {
  rules: LoadedRule[];
  totalTokens: number;
  savedTokens: number;
  loadedCategories: string[];
  skippedCategories: string[];
}

// Full context load would use all rules (~14,500 tokens)
const FULL_CONTEXT_TOKENS = 14500;

// Always load these regardless of task
const ALWAYS_LOAD_FILES = ['delegation-matrix.md'];

// Token budget management
const DEFAULT_TOKEN_BUDGET = 8000; // ~55% of full context

export class LazyLoader {
  private tokenBudget: number;
  private loadedRules: Map<string, LoadedRule> = new Map();

  constructor(tokenBudget: number = DEFAULT_TOKEN_BUDGET) {
    this.tokenBudget = tokenBudget;
  }

  /**
   * Determine which rules to load based on skill hints
   */
  planLoad(skillHints: SkillHint[]): {
    toLoad: SkillHint[];
    toSkip: SkillHint[];
    estimatedTokens: number;
  } {
    const toLoad: SkillHint[] = [];
    const toSkip: SkillHint[] = [];
    let estimatedTokens = 0;

    // Sort by priority (critical first, then high, etc.)
    const priorityOrder: Record<string, number> = {
      critical: 0,
      high: 1,
      medium: 2,
      low: 3,
    };

    const sorted = [...skillHints].sort((a, b) => {
      // Infer priority from category
      const getPriority = (hint: SkillHint): string => {
        if (hint.category === 'security') return 'critical';
        if (['delegation', 'quality'].includes(hint.category)) return 'high';
        if (hint.category === 'automation') return 'medium';
        return 'low';
      };
      return priorityOrder[getPriority(a)] - priorityOrder[getPriority(b)];
    });

    for (const hint of sorted) {
      if (estimatedTokens + hint.tokensEstimate <= this.tokenBudget) {
        toLoad.push(hint);
        estimatedTokens += hint.tokensEstimate;
      } else {
        toSkip.push(hint);
      }
    }

    return { toLoad, toSkip, estimatedTokens };
  }

  /**
   * Calculate context savings
   */
  calculateSavings(loadedTokens: number): {
    savedTokens: number;
    savingsPercent: number;
  } {
    const savedTokens = FULL_CONTEXT_TOKENS - loadedTokens;
    const savingsPercent = Math.round((savedTokens / FULL_CONTEXT_TOKENS) * 100);
    return { savedTokens, savingsPercent };
  }

  /**
   * Generate load report for logging
   */
  generateReport(result: LazyLoadResult): string {
    const { savedTokens, savingsPercent } = this.calculateSavings(result.totalTokens);

    return [
      `[LazyLoader] Context Optimization Report`,
      `  Loaded: ${result.loadedCategories.join(', ')} (${result.totalTokens} tokens)`,
      `  Skipped: ${result.skippedCategories.join(', ') || 'none'}`,
      `  Savings: ${savedTokens} tokens (${savingsPercent}%)`,
    ].join('\n');
  }

  /**
   * Build lazy load result from skill hints
   */
  buildResult(skillHints: SkillHint[]): LazyLoadResult {
    const { toLoad, toSkip, estimatedTokens } = this.planLoad(skillHints);

    return {
      rules: [], // Actual rule content would be loaded here
      totalTokens: estimatedTokens,
      savedTokens: FULL_CONTEXT_TOKENS - estimatedTokens,
      loadedCategories: toLoad.map(h => h.category),
      skippedCategories: toSkip.map(h => h.category),
    };
  }
}

// Ring buffer for conversation history (C.5 preparation)
export class ConversationRingBuffer {
  private buffer: string[] = [];
  private maxTurns: number;

  constructor(maxTurns: number = 10) {
    this.maxTurns = maxTurns;
  }

  push(turn: string): void {
    this.buffer.push(turn);
    if (this.buffer.length > this.maxTurns) {
      this.buffer.shift(); // Remove oldest
    }
  }

  getRecent(count?: number): string[] {
    const n = count ?? this.maxTurns;
    return this.buffer.slice(-n);
  }

  clear(): void {
    this.buffer = [];
  }

  get length(): number {
    return this.buffer.length;
  }
}

export default LazyLoader;
