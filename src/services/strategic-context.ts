/**
 * Strategic Context Service
 *
 * FUGUE Strategic Advisor のコンテキスト収集・管理サービス
 * Plans.md、agent-memory、harness-usage から情報を集約
 */

import type { Env } from '../types';
import type {
  StrategicContext,
  Goal,
  Decision,
  Risk,
  Insight,
  InsightType,
  VelocityMetrics,
} from '../schemas/strategic-advisor';
import { parsePlans, getCompletionRate, getPendingTaskCount } from './plans-parser';
import { safeLog } from '../utils/log-sanitizer';
import { getRuleEngine } from './insight-rules';
import { analyzeWithAI } from './ai-provider';

// =============================================================================
// Constants
// =============================================================================

const CONTEXT_CACHE_KEY = 'strategic-context:current';
const CONTEXT_CACHE_TTL = 300; // 5 minutes
const INSIGHTS_CACHE_KEY = 'strategic-insights:current';
const INSIGHTS_CACHE_TTL = 3600; // 1 hour

// =============================================================================
// Context Collection
// =============================================================================

/**
 * Plans.md からゴールを収集
 */
async function collectGoalsFromPlans(env: Env): Promise<Goal[]> {
  // Plans.md は通常ローカルファイルなので、DB に保存されたバージョンを使用
  // または Cron で定期的に同期されたデータを使用
  if (!env.DB) {
    return [];
  }

  try {
    const result = await env.DB.prepare(`
      SELECT content FROM cockpit_files
      WHERE file_path LIKE '%Plans.md'
      ORDER BY updated_at DESC
      LIMIT 1
    `).first<{ content: string }>();

    if (result?.content) {
      const { goals } = parsePlans(result.content);
      return goals;
    }
  } catch (error) {
    safeLog.warn('[StrategicContext] Failed to collect goals from Plans.md', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return [];
}

/**
 * agent-memory から意思決定履歴を収集
 */
async function collectDecisionsFromMemory(env: Env): Promise<Decision[]> {
  if (!env.DB) {
    return [];
  }

  try {
    // cockpit_tasks から decision タグ付きのタスクを抽出
    const results = await env.DB.prepare(`
      SELECT id, title, description, created_at, metadata
      FROM cockpit_tasks
      WHERE metadata LIKE '%decision%' OR metadata LIKE '%判断%'
      ORDER BY created_at DESC
      LIMIT 20
    `).all<{
      id: string;
      title: string;
      description: string | null;
      created_at: string;
      metadata: string | null;
    }>();

    if (!results.results) {
      return [];
    }

    return results.results.map((row, index) => ({
      id: `decision-${index + 1}`,
      title: row.title,
      context: row.description || '',
      chosen: row.title,
      rationale: 'タスク完了時の判断',
      madeAt: new Date(row.created_at).getTime(),
    }));
  } catch (error) {
    safeLog.warn('[StrategicContext] Failed to collect decisions', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return [];
}

/**
 * タスクとコミットから開発速度を計算
 */
async function calculateVelocity(env: Env): Promise<VelocityMetrics | undefined> {
  if (!env.DB) {
    return undefined;
  }

  try {
    // 過去7日間のタスク完了数
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const tasksResult = await env.DB.prepare(`
      SELECT COUNT(*) as count FROM cockpit_tasks
      WHERE status = 'completed' AND updated_at > ?
    `).bind(weekAgo).first<{ count: number }>();

    // 過去7日間のコミット数（repos テーブルから）
    const reposResult = await env.DB.prepare(`
      SELECT SUM(CAST(json_extract(status, '$.ahead') AS INTEGER)) as commits
      FROM cockpit_repos
      WHERE updated_at > ?
    `).bind(weekAgo).first<{ commits: number }>();

    const tasksPerWeek = tasksResult?.count || 0;
    const commitsPerWeek = reposResult?.commits || 0;

    return {
      commitsPerDay: Math.round((commitsPerWeek / 7) * 10) / 10,
      tasksCompletedPerWeek: tasksPerWeek,
      averageTaskDuration: tasksPerWeek > 0 ? 168 / tasksPerWeek : 0, // hours per task
      trend: tasksPerWeek > 5 ? 'improving' : tasksPerWeek > 2 ? 'stable' : 'declining',
    };
  } catch (error) {
    safeLog.warn('[StrategicContext] Failed to calculate velocity', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return undefined;
}

// =============================================================================
// Insight Generation
// =============================================================================

/**
 * コンテキストから洞察を生成
 */
function generateInsights(context: StrategicContext): Insight[] {
  const insights: Insight[] = [];
  const now = Date.now();

  // 1. 滞留タスクの検出（Tactical）
  const stuckGoals = context.goals.filter(g => {
    return g.status === 'active' && g.successCriteria.length > 3;
  });

  if (stuckGoals.length > 0) {
    insights.push({
      id: `insight-stuck-${now}`,
      type: 'tactical',
      title: 'タスクが滞留している可能性',
      description: `${stuckGoals.length}件のゴールに多くの未完了タスクがあります`,
      rationale: '3つ以上の未完了タスクがあるゴールは、分割を検討すべきです',
      confidence: 0.7,
      priority: 'medium',
      actionable: true,
      suggestedAction: 'タスクを小さく分割するか、優先度を見直してください',
      relatedGoals: stuckGoals.map(g => g.id),
      createdAt: now,
      expiresAt: now + 24 * 60 * 60 * 1000, // 24 hours
    });
  }

  // 2. 開発速度の変化（Reflective）
  if (context.velocity) {
    if (context.velocity.trend === 'improving') {
      insights.push({
        id: `insight-velocity-${now}`,
        type: 'reflective',
        title: '開発ペースが向上しています',
        description: `週${context.velocity.tasksCompletedPerWeek}件のタスクを完了`,
        rationale: '継続的な改善が見られます',
        confidence: 0.8,
        priority: 'low',
        actionable: false,
        createdAt: now,
        expiresAt: now + 7 * 24 * 60 * 60 * 1000, // 7 days
      });
    } else if (context.velocity.trend === 'declining') {
      insights.push({
        id: `insight-velocity-decline-${now}`,
        type: 'questioning',
        title: '開発ペースが低下しています',
        description: 'ブロッカーや優先度の問題がないか確認してください',
        rationale: '週あたりの完了タスクが減少傾向にあります',
        confidence: 0.6,
        priority: 'medium',
        actionable: true,
        suggestedAction: '現在のブロッカーを特定し、解消してください',
        createdAt: now,
        expiresAt: now + 3 * 24 * 60 * 60 * 1000, // 3 days
      });
    }
  }

  // 3. フェーズ進捗（Strategic）
  const completedGoals = context.goals.filter(g => g.status === 'completed');
  const totalGoals = context.goals.length;
  const completionRate = totalGoals > 0 ? (completedGoals.length / totalGoals) * 100 : 0;

  if (completionRate > 80) {
    insights.push({
      id: `insight-phase-complete-${now}`,
      type: 'strategic',
      title: '現在のフェーズがほぼ完了',
      description: `${Math.round(completionRate)}%のゴールが完了しました`,
      rationale: '次のフェーズの計画を始める良いタイミングです',
      confidence: 0.9,
      priority: 'high',
      actionable: true,
      suggestedAction: '次のフェーズの目標と成功基準を定義してください',
      createdAt: now,
      expiresAt: now + 7 * 24 * 60 * 60 * 1000,
    });
  }

  // 4. リスクの存在（Questioning）
  const activeRisks = context.risks.filter(r => r.status === 'active' && r.severity !== 'low');
  if (activeRisks.length > 0) {
    insights.push({
      id: `insight-risks-${now}`,
      type: 'questioning',
      title: '未対処のリスクがあります',
      description: `${activeRisks.length}件の${activeRisks[0]?.severity || 'medium'}リスクに対処が必要です`,
      rationale: 'リスクは早期に軽減することで影響を最小化できます',
      confidence: 0.85,
      priority: activeRisks[0]?.severity === 'critical' ? 'high' : 'medium',
      actionable: true,
      suggestedAction: 'リスク軽減策を実行してください',
      createdAt: now,
      expiresAt: now + 2 * 24 * 60 * 60 * 1000,
    });
  }

  return insights;
}

// =============================================================================
// Public API
// =============================================================================

/**
 * 現在の戦略的コンテキストを取得
 */
export async function getStrategicContext(env: Env): Promise<StrategicContext> {
  // キャッシュを確認
  if (env.CACHE) {
    try {
      const cached = await env.CACHE.get(CONTEXT_CACHE_KEY);
      if (cached) {
        return JSON.parse(cached) as StrategicContext;
      }
    } catch (error) {
      safeLog.warn('[StrategicContext] Cache read failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // コンテキストを収集
  const [goals, decisions, velocity] = await Promise.all([
    collectGoalsFromPlans(env),
    collectDecisionsFromMemory(env),
    calculateVelocity(env),
  ]);

  const context: StrategicContext = {
    goals,
    currentPhase: goals.length > 0 ? 'Active Development' : 'Planning',
    decisions,
    risks: [], // TODO: リスク収集を実装
    assumptions: [], // TODO: 前提条件収集を実装
    velocity,
    toolUsage: undefined, // TODO: ツール使用状況収集を実装
    updatedAt: Date.now(),
    nextReviewAt: Date.now() + 24 * 60 * 60 * 1000, // 24 hours later
  };

  // キャッシュに保存
  if (env.CACHE) {
    try {
      await env.CACHE.put(CONTEXT_CACHE_KEY, JSON.stringify(context), {
        expirationTtl: CONTEXT_CACHE_TTL,
      });
    } catch (error) {
      safeLog.warn('[StrategicContext] Cache write failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return context;
}

/**
 * 洞察を取得（ルールエンジン統合版）
 */
export async function getInsights(
  env: Env,
  options?: {
    limit?: number;
    types?: InsightType[];
    includeDismissed?: boolean;
    useRuleEngine?: boolean;
  }
): Promise<Insight[]> {
  const context = await getStrategicContext(env);

  // ルールエンジンとレガシー生成を併用
  const ruleEngine = getRuleEngine();
  const ruleInsights = ruleEngine.generateInsights(context);
  const legacyInsights = generateInsights(context);

  // 重複を除去してマージ（ルールエンジンを優先）
  const insightMap = new Map<string, Insight>();
  for (const insight of legacyInsights) {
    insightMap.set(insight.id, insight);
  }
  for (const insight of ruleInsights) {
    insightMap.set(insight.id, insight);
  }

  let insights = Array.from(insightMap.values());

  safeLog.log('[StrategicContext] Insights generated', {
    ruleEngineCount: ruleInsights.length,
    legacyCount: legacyInsights.length,
    mergedCount: insights.length,
  });

  // フィルタリング
  if (options?.types && options.types.length > 0) {
    insights = insights.filter(i => options.types!.includes(i.type));
  }

  if (!options?.includeDismissed) {
    insights = insights.filter(i => !i.dismissed);
  }

  // ソート（優先度 > 信頼度）
  insights.sort((a, b) => {
    const priorityOrder = { high: 0, medium: 1, low: 2 };
    const pDiff = priorityOrder[a.priority] - priorityOrder[b.priority];
    if (pDiff !== 0) return pDiff;
    return b.confidence - a.confidence;
  });

  // 件数制限
  const limit = options?.limit || 3;
  return insights.slice(0, limit);
}

/**
 * AI を使用してコンテキストから高度な洞察を生成
 */
export async function generateAIInsights(
  env: Env,
  context: StrategicContext
): Promise<Insight[]> {
  const prompt = `以下の開発コンテキストを分析し、戦略的な洞察を3つ生成してください。

## コンテキスト
- 現在のフェーズ: ${context.currentPhase}
- アクティブなゴール数: ${context.goals.filter(g => g.status === 'active').length}
- 完了済みゴール数: ${context.goals.filter(g => g.status === 'completed').length}
- 最近の意思決定: ${context.decisions.slice(0, 3).map(d => d.title).join(', ') || 'なし'}
- 開発速度: ${context.velocity ? `${context.velocity.tasksCompletedPerWeek / 7} tasks/day` : '不明'}

## 出力形式（JSON）
[
  {
    "type": "strategic" | "tactical" | "reflective" | "questioning",
    "title": "短いタイトル",
    "description": "詳細な説明",
    "suggestedAction": "推奨アクション",
    "confidence": 0.0-1.0,
    "priority": "high" | "medium" | "low"
  }
]`;

  try {
    const result = await analyzeWithAI(prompt, '', env, { preferredProvider: 'auto' });

    // JSON を抽出してパース
    const jsonMatch = result.content.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      safeLog.warn('[StrategicContext] AI did not return valid JSON');
      return [];
    }

    const rawInsights = JSON.parse(jsonMatch[0]) as Array<{
      type: InsightType;
      title: string;
      description: string;
      suggestedAction?: string;
      confidence: number;
      priority: 'high' | 'medium' | 'low';
    }>;

    const now = Date.now();
    return rawInsights.map((raw, idx) => ({
      id: `ai-insight-${now}-${idx}`,
      type: raw.type,
      title: raw.title,
      description: raw.description,
      rationale: `AI analysis by ${result.provider}`,
      suggestedAction: raw.suggestedAction,
      confidence: raw.confidence,
      priority: raw.priority,
      actionable: !!raw.suggestedAction,
      source: 'ai-analysis',
      createdAt: now,
    }));
  } catch (error) {
    safeLog.error('[StrategicContext] AI insight generation failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/**
 * 洞察にフィードバックを送信
 */
export async function submitInsightFeedback(
  env: Env,
  insightId: string,
  action: 'accepted' | 'dismissed' | 'snoozed',
  feedback?: string
): Promise<boolean> {
  if (!env.DB) {
    return false;
  }

  try {
    await env.DB.prepare(`
      INSERT INTO cockpit_insight_feedback (insight_id, action, feedback, timestamp)
      VALUES (?, ?, ?, ?)
    `).bind(insightId, action, feedback || null, Date.now()).run();

    safeLog.log('[StrategicContext] Insight feedback recorded', {
      insightId,
      action,
    });

    return true;
  } catch (error) {
    safeLog.error('[StrategicContext] Failed to record feedback', {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Plans.md の内容を DB に同期
 */
export async function syncPlansContent(env: Env, content: string, filePath: string): Promise<void> {
  if (!env.DB) {
    return;
  }

  try {
    await env.DB.prepare(`
      INSERT INTO cockpit_files (file_path, content, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(file_path) DO UPDATE SET
        content = excluded.content,
        updated_at = datetime('now')
    `).bind(filePath, content).run();

    // キャッシュを無効化
    if (env.CACHE) {
      await env.CACHE.delete(CONTEXT_CACHE_KEY);
    }

    safeLog.log('[StrategicContext] Plans.md synced', { filePath });
  } catch (error) {
    safeLog.error('[StrategicContext] Failed to sync Plans.md', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
