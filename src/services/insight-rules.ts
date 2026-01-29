/**
 * Insight Rule Engine
 *
 * Strategic Advisor Phase 2: Intelligence Layer
 *
 * 設定可能なルールエンジンで Insight を自動生成
 * - 滞留タスク検出
 * - パターン認識
 * - リスク分析
 * - 進捗評価
 */

import type { StrategicContext, Goal, Insight, InsightType } from '../schemas/strategic-advisor';
import { safeLog } from '../utils/log-sanitizer';

// =============================================================================
// Types
// =============================================================================

export interface InsightRule {
  id: string;
  name: string;
  description: string;
  type: InsightType;
  priority: number;
  enabled: boolean;
  config: RuleConfig;
  trigger: (context: StrategicContext, config: RuleConfig) => boolean;
  generate: (context: StrategicContext, config: RuleConfig) => Insight | null;
}

export interface RuleConfig {
  [key: string]: unknown;
}

export interface RuleEngineConfig {
  maxInsightsPerRun: number;
  enabledRuleIds?: string[];
  disabledRuleIds?: string[];
  customConfigs?: Record<string, RuleConfig>;
}

// =============================================================================
// Default Rule Configurations
// =============================================================================

const DEFAULT_ENGINE_CONFIG: RuleEngineConfig = {
  maxInsightsPerRun: 5,
};

// =============================================================================
// Built-in Rules
// =============================================================================

const stuckTasksRule: InsightRule = {
  id: 'stuck-tasks',
  name: '滞留タスク検出',
  description: '長期間進捗のないタスクを検出',
  type: 'tactical',
  priority: 1,
  enabled: true,
  config: {
    stuckThresholdDays: 3,
    minSuccessCriteria: 3,
  },
  trigger: (context, config) => {
    const threshold = (config.stuckThresholdDays as number) || 3;
    const now = Date.now();
    const thresholdMs = threshold * 24 * 60 * 60 * 1000;

    return context.goals.some(goal =>
      goal.status === 'active' &&
      goal.updatedAt &&
      (now - goal.updatedAt) > thresholdMs
    );
  },
  generate: (context, config) => {
    const threshold = (config.stuckThresholdDays as number) || 3;
    const now = Date.now();
    const thresholdMs = threshold * 24 * 60 * 60 * 1000;

    const stuckGoals = context.goals.filter(goal =>
      goal.status === 'active' &&
      goal.updatedAt &&
      (now - goal.updatedAt) > thresholdMs
    );

    if (stuckGoals.length === 0) return null;

    const goalNames = stuckGoals.map(g => g.title).join(', ');
    const daysStuck = Math.floor((now - (stuckGoals[0].updatedAt || now)) / (24 * 60 * 60 * 1000));

    return {
      id: `insight-stuck-${Date.now()}`,
      type: 'tactical',
      title: `${stuckGoals.length}件のタスクが${daysStuck}日以上滞留`,
      description: `以下のタスクが長期間更新されていません: ${goalNames}`,
      suggestedAction: 'タスクを分割するか、ブロッカーを特定して解決してください',
      confidence: 0.85,
      priority: 'high',
      source: 'rule-engine',
      ruleId: 'stuck-tasks',
      relatedGoalIds: stuckGoals.map(g => g.id),
      createdAt: now,
    };
  },
};

const tooManyActiveTasksRule: InsightRule = {
  id: 'too-many-active',
  name: 'WIP 過多検出',
  description: '同時進行タスクが多すぎる場合に警告',
  type: 'strategic',
  priority: 2,
  enabled: true,
  config: {
    maxActiveGoals: 5,
  },
  trigger: (context, config) => {
    const maxActive = (config.maxActiveGoals as number) || 5;
    const activeCount = context.goals.filter(g => g.status === 'active').length;
    return activeCount > maxActive;
  },
  generate: (context, config) => {
    const maxActive = (config.maxActiveGoals as number) || 5;
    const activeGoals = context.goals.filter(g => g.status === 'active');

    if (activeGoals.length <= maxActive) return null;

    return {
      id: `insight-wip-${Date.now()}`,
      type: 'strategic',
      title: `WIP 過多: ${activeGoals.length}件が同時進行中`,
      description: `推奨上限 ${maxActive}件を超えています。フォーカスを絞ることで完了速度が向上します。`,
      suggestedAction: '優先度の低いタスクを「保留」に変更し、重要なタスクに集中してください',
      confidence: 0.9,
      priority: 'medium',
      source: 'rule-engine',
      ruleId: 'too-many-active',
      createdAt: Date.now(),
    };
  },
};

const completionCelebrationRule: InsightRule = {
  id: 'completion-celebration',
  name: '完了祝福',
  description: '大きなマイルストーン達成時に祝福',
  type: 'reflective',
  priority: 5,
  enabled: true,
  config: {
    recentCompletionHours: 24,
    minCompletedForCelebration: 3,
  },
  trigger: (context, config) => {
    const hours = (config.recentCompletionHours as number) || 24;
    const minCompleted = (config.minCompletedForCelebration as number) || 3;
    const now = Date.now();
    const windowMs = hours * 60 * 60 * 1000;

    const recentlyCompleted = context.goals.filter(g =>
      g.status === 'completed' &&
      g.updatedAt &&
      (now - g.updatedAt) < windowMs
    );

    return recentlyCompleted.length >= minCompleted;
  },
  generate: (context, config) => {
    const hours = (config.recentCompletionHours as number) || 24;
    const now = Date.now();
    const windowMs = hours * 60 * 60 * 1000;

    const recentlyCompleted = context.goals.filter(g =>
      g.status === 'completed' &&
      g.updatedAt &&
      (now - g.updatedAt) < windowMs
    );

    if (recentlyCompleted.length === 0) return null;

    return {
      id: `insight-celebrate-${Date.now()}`,
      type: 'reflective',
      title: `🎉 ${recentlyCompleted.length}件のタスクを完了！`,
      description: `直近${hours}時間で素晴らしい進捗です。このペースを維持しましょう。`,
      confidence: 1.0,
      priority: 'low',
      source: 'rule-engine',
      ruleId: 'completion-celebration',
      relatedGoalIds: recentlyCompleted.map(g => g.id),
      createdAt: now,
    };
  },
};

const noProgressRule: InsightRule = {
  id: 'no-progress',
  name: '進捗なし警告',
  description: '一定期間コンテキスト更新がない場合に問いかけ',
  type: 'questioning',
  priority: 3,
  enabled: true,
  config: {
    noUpdateThresholdHours: 48,
  },
  trigger: (context, config) => {
    const hours = (config.noUpdateThresholdHours as number) || 48;
    const now = Date.now();
    const thresholdMs = hours * 60 * 60 * 1000;

    // 最新の更新時刻を確認
    const latestUpdate = Math.max(
      ...context.goals.map(g => g.updatedAt || 0),
      context.updatedAt || 0
    );

    return latestUpdate > 0 && (now - latestUpdate) > thresholdMs;
  },
  generate: (context, config) => {
    const hours = (config.noUpdateThresholdHours as number) || 48;

    return {
      id: `insight-noprogress-${Date.now()}`,
      type: 'questioning',
      title: `${hours}時間以上更新がありません`,
      description: '作業が停滞していませんか？ブロッカーや優先度の見直しが必要かもしれません。',
      suggestedAction: '現在の状況を振り返り、次のアクションを明確にしてください',
      confidence: 0.7,
      priority: 'medium',
      source: 'rule-engine',
      ruleId: 'no-progress',
      createdAt: Date.now(),
    };
  },
};

const duplicatePatternRule: InsightRule = {
  id: 'duplicate-pattern',
  name: '重複パターン検出',
  description: '類似したタスクやゴールを検出',
  type: 'strategic',
  priority: 2,
  enabled: true,
  config: {
    similarityThreshold: 0.6,
  },
  trigger: (context) => {
    const activeGoals = context.goals.filter(g => g.status === 'active');
    if (activeGoals.length < 2) return false;

    // 簡易的な類似度チェック（タイトルの単語重複）
    for (let i = 0; i < activeGoals.length; i++) {
      for (let j = i + 1; j < activeGoals.length; j++) {
        const similarity = calculateSimilarity(activeGoals[i].title, activeGoals[j].title);
        if (similarity > 0.6) return true;
      }
    }
    return false;
  },
  generate: (context) => {
    const activeGoals = context.goals.filter(g => g.status === 'active');
    const duplicates: Array<[Goal, Goal, number]> = [];

    for (let i = 0; i < activeGoals.length; i++) {
      for (let j = i + 1; j < activeGoals.length; j++) {
        const similarity = calculateSimilarity(activeGoals[i].title, activeGoals[j].title);
        if (similarity > 0.6) {
          duplicates.push([activeGoals[i], activeGoals[j], similarity]);
        }
      }
    }

    if (duplicates.length === 0) return null;

    const [goal1, goal2] = duplicates[0];

    return {
      id: `insight-duplicate-${Date.now()}`,
      type: 'strategic',
      title: '類似タスクを検出',
      description: `「${goal1.title}」と「${goal2.title}」は類似しています。統合を検討してください。`,
      suggestedAction: '重複を排除し、タスクを統合することで効率が向上します',
      confidence: 0.75,
      priority: 'medium',
      source: 'rule-engine',
      ruleId: 'duplicate-pattern',
      relatedGoalIds: [goal1.id, goal2.id],
      createdAt: Date.now(),
    };
  },
};

// =============================================================================
// Helper Functions
// =============================================================================

function calculateSimilarity(str1: string, str2: string): number {
  const words1 = new Set(str1.toLowerCase().split(/\s+/));
  const words2 = new Set(str2.toLowerCase().split(/\s+/));

  const intersection = new Set([...words1].filter(x => words2.has(x)));
  const union = new Set([...words1, ...words2]);

  return union.size > 0 ? intersection.size / union.size : 0;
}

// =============================================================================
// Default Rules Registry
// =============================================================================

const DEFAULT_RULES: InsightRule[] = [
  stuckTasksRule,
  tooManyActiveTasksRule,
  completionCelebrationRule,
  noProgressRule,
  duplicatePatternRule,
];

// =============================================================================
// Rule Engine
// =============================================================================

export class InsightRuleEngine {
  private rules: Map<string, InsightRule>;
  private config: RuleEngineConfig;

  constructor(config?: Partial<RuleEngineConfig>) {
    this.config = { ...DEFAULT_ENGINE_CONFIG, ...config };
    this.rules = new Map();

    // デフォルトルールを登録
    DEFAULT_RULES.forEach(rule => this.registerRule(rule));
  }

  /**
   * ルールを登録
   */
  registerRule(rule: InsightRule): void {
    this.rules.set(rule.id, rule);
    safeLog.log('[RuleEngine] Rule registered', { ruleId: rule.id, name: rule.name });
  }

  /**
   * ルールを削除
   */
  unregisterRule(ruleId: string): boolean {
    return this.rules.delete(ruleId);
  }

  /**
   * ルール設定を更新
   */
  updateRuleConfig(ruleId: string, config: Partial<RuleConfig>): boolean {
    const rule = this.rules.get(ruleId);
    if (!rule) return false;

    rule.config = { ...rule.config, ...config };
    return true;
  }

  /**
   * ルールを有効化/無効化
   */
  setRuleEnabled(ruleId: string, enabled: boolean): boolean {
    const rule = this.rules.get(ruleId);
    if (!rule) return false;

    rule.enabled = enabled;
    return true;
  }

  /**
   * 全ルールを実行して Insight を生成
   */
  generateInsights(context: StrategicContext): Insight[] {
    const insights: Insight[] = [];
    const enabledRules = Array.from(this.rules.values())
      .filter(rule => {
        if (!rule.enabled) return false;
        if (this.config.enabledRuleIds && !this.config.enabledRuleIds.includes(rule.id)) return false;
        if (this.config.disabledRuleIds?.includes(rule.id)) return false;
        return true;
      })
      .sort((a, b) => a.priority - b.priority);

    safeLog.log('[RuleEngine] Running rules', {
      totalRules: this.rules.size,
      enabledRules: enabledRules.length,
    });

    for (const rule of enabledRules) {
      if (insights.length >= this.config.maxInsightsPerRun) {
        safeLog.log('[RuleEngine] Max insights reached', { max: this.config.maxInsightsPerRun });
        break;
      }

      try {
        // カスタム設定をマージ
        const ruleConfig = {
          ...rule.config,
          ...(this.config.customConfigs?.[rule.id] || {}),
        };

        if (rule.trigger(context, ruleConfig)) {
          const insight = rule.generate(context, ruleConfig);
          if (insight) {
            insights.push(insight);
            safeLog.log('[RuleEngine] Insight generated', {
              ruleId: rule.id,
              insightId: insight.id,
              type: insight.type,
            });
          }
        }
      } catch (error) {
        safeLog.error('[RuleEngine] Rule execution failed', {
          ruleId: rule.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return insights;
  }

  /**
   * 登録済みルール一覧を取得
   */
  getRules(): InsightRule[] {
    return Array.from(this.rules.values());
  }

  /**
   * 特定のルールを取得
   */
  getRule(ruleId: string): InsightRule | undefined {
    return this.rules.get(ruleId);
  }
}

// =============================================================================
// Singleton Instance
// =============================================================================

let engineInstance: InsightRuleEngine | null = null;

export function getRuleEngine(config?: Partial<RuleEngineConfig>): InsightRuleEngine {
  if (!engineInstance) {
    engineInstance = new InsightRuleEngine(config);
  }
  return engineInstance;
}

export function resetRuleEngine(): void {
  engineInstance = null;
}
