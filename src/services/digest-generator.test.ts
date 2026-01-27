import { describe, it, expect } from 'vitest';
import {
  parseJsonArray,
  aggregateWeeklyDigest,
  aggregateActionItems,
  generateWeeklyMarkdown,
  generateMonthlyMarkdown,
  generateActionItemsMarkdown,
  type LifelogRecord,
} from './digest-generator';

// ============================================================================
// Test Helpers
// ============================================================================

function createLifelog(overrides: Partial<LifelogRecord> = {}): LifelogRecord {
  return {
    id: 'test-id',
    classification: 'casual',
    summary: null,
    key_insights: [],
    action_items: [],
    topics: [],
    speakers: [],
    sentiment: 'neutral',
    title: null,
    start_time: '2026-01-20T10:00:00Z',
    end_time: '2026-01-20T10:30:00Z',
    duration_seconds: 1800,
    is_starred: false,
    ...overrides,
  };
}

function createWeekOfLogs(): LifelogRecord[] {
  return [
    createLifelog({
      id: '1',
      classification: 'meeting',
      summary: 'Cloudflare Workers の設計レビュー',
      topics: ['Cloudflare Workers', 'API設計'],
      action_items: ['Workers AI の設定を更新する'],
      key_insights: ['Durable Objects は状態管理に有効'],
      sentiment: 'positive',
      title: '設計レビュー',
      start_time: '2026-01-20T01:00:00Z', // JST 10:00
      duration_seconds: 3600,
      is_starred: true,
    }),
    createLifelog({
      id: '2',
      classification: 'insight',
      summary: 'GPT-4o-miniの日本語処理能力について',
      topics: ['GPT-4o-mini', 'AI'],
      key_insights: ['GPT-4o-miniは日本語の文脈理解が優れている'],
      sentiment: 'positive',
      title: 'AI性能評価',
      start_time: '2026-01-20T03:00:00Z', // JST 12:00
      duration_seconds: 1200,
    }),
    createLifelog({
      id: '3',
      classification: 'casual',
      summary: '電車アナウンス',
      topics: [],
      sentiment: 'neutral',
      start_time: '2026-01-21T00:00:00Z', // JST 09:00
      duration_seconds: 300,
    }),
    createLifelog({
      id: '4',
      classification: 'brainstorm',
      summary: '週次ダイジェスト機能の設計',
      topics: ['Obsidian', 'Pendant'],
      action_items: ['Supabase にテーブル作成', 'Cron ジョブ設定'],
      key_insights: ['PostgREST で集計はできないのでWorker側で行う'],
      sentiment: 'positive',
      title: 'ブレスト',
      start_time: '2026-01-22T02:00:00Z', // JST 11:00
      duration_seconds: 2400,
      is_starred: true,
    }),
    createLifelog({
      id: '5',
      classification: 'todo',
      summary: 'タスク整理',
      topics: ['Cloudflare Workers'],
      action_items: ['Workers AI の設定を更新する', 'テスト追加'],
      sentiment: 'neutral',
      start_time: '2026-01-23T05:00:00Z', // JST 14:00
      duration_seconds: 600,
    }),
    createLifelog({
      id: '6',
      classification: 'casual',
      summary: '雑談',
      sentiment: 'mixed',
      start_time: '2026-01-24T06:00:00Z', // JST 15:00
      duration_seconds: 900,
    }),
    createLifelog({
      id: '7',
      classification: 'meeting',
      summary: 'Stripe決済連携の確認',
      topics: ['Stripe', 'API設計'],
      action_items: ['Webhook署名検証を実装'],
      sentiment: 'neutral',
      title: 'Stripe MTG',
      start_time: '2026-01-25T01:00:00Z', // JST 10:00
      duration_seconds: 1800,
    }),
  ];
}

// ============================================================================
// parseJsonArray
// ============================================================================

describe('parseJsonArray', () => {
  it('should return empty array for null/undefined', () => {
    expect(parseJsonArray(null)).toEqual([]);
    expect(parseJsonArray(undefined)).toEqual([]);
    expect(parseJsonArray('')).toEqual([]);
  });

  it('should return array as-is if already parsed', () => {
    expect(parseJsonArray(['a', 'b'])).toEqual(['a', 'b']);
  });

  it('should parse JSON string to array', () => {
    expect(parseJsonArray('["a","b"]')).toEqual(['a', 'b']);
  });

  it('should handle non-array JSON gracefully', () => {
    expect(parseJsonArray('{"key": "value"}')).toEqual([]);
    expect(parseJsonArray('"hello"')).toEqual([]);
  });

  it('should handle invalid JSON string gracefully', () => {
    expect(parseJsonArray('not json')).toEqual([]);
    expect(parseJsonArray('[broken')).toEqual([]);
  });

  it('should filter out non-string elements', () => {
    expect(parseJsonArray([1, 'a', null, 'b'])).toEqual(['a', 'b']);
  });
});

// ============================================================================
// aggregateWeeklyDigest
// ============================================================================

describe('aggregateWeeklyDigest', () => {
  it('should handle empty input', () => {
    const result = aggregateWeeklyDigest([], '2026-01-20', '2026-01-26');
    expect(result.totalRecordings).toBe(0);
    expect(result.totalDurationSeconds).toBe(0);
    expect(result.topTopics).toEqual([]);
    expect(result.allActionItems).toEqual([]);
    expect(result.dailyStats).toEqual([]);
  });

  it('should aggregate classification breakdown', () => {
    const logs = createWeekOfLogs();
    const result = aggregateWeeklyDigest(logs, '2026-01-20', '2026-01-26');

    expect(result.classificationBreakdown['meeting']).toBe(2);
    expect(result.classificationBreakdown['casual']).toBe(2);
    expect(result.classificationBreakdown['insight']).toBe(1);
    expect(result.classificationBreakdown['brainstorm']).toBe(1);
    expect(result.classificationBreakdown['todo']).toBe(1);
  });

  it('should count total recordings and duration', () => {
    const logs = createWeekOfLogs();
    const result = aggregateWeeklyDigest(logs, '2026-01-20', '2026-01-26');

    expect(result.totalRecordings).toBe(7);
    expect(result.totalDurationSeconds).toBe(3600 + 1200 + 300 + 2400 + 600 + 900 + 1800);
  });

  it('should count starred recordings', () => {
    const logs = createWeekOfLogs();
    const result = aggregateWeeklyDigest(logs, '2026-01-20', '2026-01-26');

    expect(result.starredCount).toBe(2);
  });

  it('should aggregate and sort topics by frequency', () => {
    const logs = createWeekOfLogs();
    const result = aggregateWeeklyDigest(logs, '2026-01-20', '2026-01-26');

    // 'Cloudflare Workers' appears in logs 1 and 5, 'API設計' in 1 and 7
    expect(result.topTopics[0].count).toBeGreaterThanOrEqual(2);
    expect(result.topTopics.length).toBeGreaterThan(0);
    expect(result.topTopics.length).toBeLessThanOrEqual(15);
  });

  it('should deduplicate action items', () => {
    const logs = createWeekOfLogs();
    const result = aggregateWeeklyDigest(logs, '2026-01-20', '2026-01-26');

    // 'Workers AI の設定を更新する' appears in logs 1 and 5 but should be deduplicated
    const workerAIItems = result.allActionItems.filter((i) => i.includes('Workers AI'));
    expect(workerAIItems.length).toBe(1);
  });

  it('should aggregate sentiment distribution', () => {
    const logs = createWeekOfLogs();
    const result = aggregateWeeklyDigest(logs, '2026-01-20', '2026-01-26');

    expect(result.sentimentDistribution['positive']).toBe(3);
    expect(result.sentimentDistribution['neutral']).toBe(3);
    expect(result.sentimentDistribution['mixed']).toBe(1);
  });

  it('should generate daily stats sorted by date', () => {
    const logs = createWeekOfLogs();
    const result = aggregateWeeklyDigest(logs, '2026-01-20', '2026-01-26');

    expect(result.dailyStats.length).toBeGreaterThan(0);
    // Should be sorted by date
    for (let i = 1; i < result.dailyStats.length; i++) {
      expect(result.dailyStats[i].date >= result.dailyStats[i - 1].date).toBe(true);
    }
  });

  it('should extract highlights from meaningful classifications', () => {
    const logs = createWeekOfLogs();
    const result = aggregateWeeklyDigest(logs, '2026-01-20', '2026-01-26');

    // casual recordings should not be in highlights
    const casualHighlights = result.highlights.filter((h) => h.classification === 'casual');
    expect(casualHighlights.length).toBe(0);

    // meetings, insights, brainstorms should be in highlights
    expect(result.highlights.length).toBeGreaterThan(0);
  });

  it('should handle JSONB fields arriving as strings', () => {
    const log = createLifelog({
      topics: '["TopicA", "TopicB"]' as unknown as string[],
      action_items: '["Do something"]' as unknown as string[],
      key_insights: '["Important finding"]' as unknown as string[],
    });

    const result = aggregateWeeklyDigest([log], '2026-01-20', '2026-01-26');

    expect(result.topTopics.length).toBe(2);
    expect(result.allActionItems).toContain('Do something');
    expect(result.allInsights).toContain('Important finding');
  });
});

// ============================================================================
// aggregateActionItems
// ============================================================================

describe('aggregateActionItems', () => {
  it('should handle empty input', () => {
    const result = aggregateActionItems([], '2026-01-20', '2026-01-26');
    expect(result.totalItems).toBe(0);
    expect(result.recentItems).toEqual([]);
    expect(result.itemsByTopic).toEqual({});
  });

  it('should group action items by first topic', () => {
    const logs = createWeekOfLogs();
    const result = aggregateActionItems(logs, '2026-01-20', '2026-01-26');

    expect(Object.keys(result.itemsByTopic).length).toBeGreaterThan(0);
    // All items should be accounted for
    const totalFromTopics = Object.values(result.itemsByTopic).reduce((sum, items) => sum + items.length, 0);
    expect(totalFromTopics).toBeGreaterThan(0);
  });

  it('should include date and classification per item', () => {
    const logs = createWeekOfLogs();
    const result = aggregateActionItems(logs, '2026-01-20', '2026-01-26');

    for (const item of result.recentItems) {
      expect(item.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(item.classification).toBeTruthy();
    }
  });

  it('should filter out short items', () => {
    const log = createLifelog({
      action_items: ['Do', 'Do this important thing', 'XX'],
    });
    const result = aggregateActionItems([log], '2026-01-20', '2026-01-26');

    expect(result.totalItems).toBe(1); // Only 'Do this important thing' passes length > 3
  });
});

// ============================================================================
// generateWeeklyMarkdown
// ============================================================================

describe('generateWeeklyMarkdown', () => {
  it('should generate valid frontmatter', () => {
    const logs = createWeekOfLogs();
    const digest = aggregateWeeklyDigest(logs, '2026-01-20', '2026-01-26');
    const md = generateWeeklyMarkdown(digest);

    expect(md).toContain('---');
    expect(md).toContain('type: weekly-digest');
    expect(md).toContain('source: Limitless Pendant');
    expect(md).toContain('tags: [pendant, weekly');
  });

  it('should include summary stats line', () => {
    const logs = createWeekOfLogs();
    const digest = aggregateWeeklyDigest(logs, '2026-01-20', '2026-01-26');
    const md = generateWeeklyMarkdown(digest);

    expect(md).toContain('7件');
  });

  it('should include topic trend table', () => {
    const logs = createWeekOfLogs();
    const digest = aggregateWeeklyDigest(logs, '2026-01-20', '2026-01-26');
    const md = generateWeeklyMarkdown(digest);

    expect(md).toContain('## トピックトレンド');
    expect(md).toContain('| # | トピック | 回数 | 分類 |');
  });

  it('should include action items as checkboxes', () => {
    const logs = createWeekOfLogs();
    const digest = aggregateWeeklyDigest(logs, '2026-01-20', '2026-01-26');
    const md = generateWeeklyMarkdown(digest);

    expect(md).toContain('## Action Items');
    expect(md).toContain('- [ ] ');
  });

  it('should include sentiment distribution', () => {
    const logs = createWeekOfLogs();
    const digest = aggregateWeeklyDigest(logs, '2026-01-20', '2026-01-26');
    const md = generateWeeklyMarkdown(digest);

    expect(md).toContain('## 感情トレンド');
    expect(md).toContain('positive');
  });

  it('should include daily activity table', () => {
    const logs = createWeekOfLogs();
    const digest = aggregateWeeklyDigest(logs, '2026-01-20', '2026-01-26');
    const md = generateWeeklyMarkdown(digest);

    expect(md).toContain('## 日別アクティビティ');
    expect(md).toContain('| 日付 | 録音数 | 時間 | 主な活動 |');
  });

  it('should include busyness section', () => {
    const logs = createWeekOfLogs();
    const digest = aggregateWeeklyDigest(logs, '2026-01-20', '2026-01-26');
    const md = generateWeeklyMarkdown(digest);

    expect(md).toContain('## 多忙度');
    expect(md).toContain('活動量:');
  });

  it('should handle empty data gracefully', () => {
    const digest = aggregateWeeklyDigest([], '2026-01-20', '2026-01-26');
    const md = generateWeeklyMarkdown(digest);

    expect(md).toContain('---');
    expect(md).toContain('# ');
    expect(md).toContain('0件');
    // Should not have section headers for empty data
    expect(md).not.toContain('## Action Items');
    expect(md).not.toContain('## トピックトレンド');
  });
});

// ============================================================================
// generateActionItemsMarkdown
// ============================================================================

describe('generateActionItemsMarkdown', () => {
  it('should generate valid frontmatter', () => {
    const logs = createWeekOfLogs();
    const report = aggregateActionItems(logs, '2026-01-20', '2026-01-26');
    const md = generateActionItemsMarkdown(report);

    expect(md).toContain('---');
    expect(md).toContain('type: action-items');
    expect(md).toContain('tags: [pendant, actions]');
  });

  it('should group items by topic with checkboxes', () => {
    const logs = createWeekOfLogs();
    const report = aggregateActionItems(logs, '2026-01-20', '2026-01-26');
    const md = generateActionItemsMarkdown(report);

    expect(md).toContain('- [ ] ');
    expect(md).toContain('## '); // Topic headers
  });

  it('should handle empty report', () => {
    const report = aggregateActionItems([], '2026-01-20', '2026-01-26');
    const md = generateActionItemsMarkdown(report);

    expect(md).toContain('0件のアクションアイテム');
  });

  it('should include Dataview frontmatter fields', () => {
    const logs = createWeekOfLogs();
    const report = aggregateActionItems(logs, '2026-01-20', '2026-01-26');
    const md = generateActionItemsMarkdown(report);

    expect(md).toContain('period_start: 2026-01-20');
    expect(md).toContain('period_end: 2026-01-26');
    expect(md).toContain('topic_count:');
    expect(md).toContain('total_items:');
  });
});

// ============================================================================
// generateMonthlyMarkdown
// ============================================================================

describe('generateMonthlyMarkdown', () => {
  it('should generate valid frontmatter with monthly type', () => {
    const logs = createWeekOfLogs();
    const digest = aggregateWeeklyDigest(logs, '2026-01-01', '2026-01-31');
    const md = generateMonthlyMarkdown(digest);

    expect(md).toContain('---');
    expect(md).toContain('type: monthly-digest');
    expect(md).toContain('source: Limitless Pendant');
    expect(md).toContain('tags: [pendant, monthly');
  });

  it('should use YYYY-MM as label', () => {
    const logs = createWeekOfLogs();
    const digest = aggregateWeeklyDigest(logs, '2026-01-01', '2026-01-31');
    const md = generateMonthlyMarkdown(digest);

    expect(md).toContain('date: 2026-01');
    expect(md).toContain('# 2026-01 月次レポート');
  });

  it('should include summary stats', () => {
    const logs = createWeekOfLogs();
    const digest = aggregateWeeklyDigest(logs, '2026-01-01', '2026-01-31');
    const md = generateMonthlyMarkdown(digest);

    expect(md).toContain('7件');
  });

  it('should include weekly breakdown table', () => {
    const logs = createWeekOfLogs();
    const digest = aggregateWeeklyDigest(logs, '2026-01-01', '2026-01-31');
    const md = generateMonthlyMarkdown(digest);

    expect(md).toContain('## 週別アクティビティ');
    expect(md).toContain('| 週 | 録音数 | 時間 | 主な活動 |');
  });

  it('should include action items', () => {
    const logs = createWeekOfLogs();
    const digest = aggregateWeeklyDigest(logs, '2026-01-01', '2026-01-31');
    const md = generateMonthlyMarkdown(digest);

    expect(md).toContain('## Action Items');
    expect(md).toContain('- [ ] ');
  });

  it('should include topic trends', () => {
    const logs = createWeekOfLogs();
    const digest = aggregateWeeklyDigest(logs, '2026-01-01', '2026-01-31');
    const md = generateMonthlyMarkdown(digest);

    expect(md).toContain('## トピックトレンド');
    expect(md).toContain('| # | トピック | 回数 | 分類 |');
  });

  it('should include sentiment trends', () => {
    const logs = createWeekOfLogs();
    const digest = aggregateWeeklyDigest(logs, '2026-01-01', '2026-01-31');
    const md = generateMonthlyMarkdown(digest);

    expect(md).toContain('## 感情トレンド');
    expect(md).toContain('positive');
  });

  it('should include busyness section', () => {
    const logs = createWeekOfLogs();
    const digest = aggregateWeeklyDigest(logs, '2026-01-01', '2026-01-31');
    const md = generateMonthlyMarkdown(digest);

    expect(md).toContain('## 多忙度');
    expect(md).toContain('活動量:');
  });

  it('should handle empty data gracefully', () => {
    const digest = aggregateWeeklyDigest([], '2026-01-01', '2026-01-31');
    const md = generateMonthlyMarkdown(digest);

    expect(md).toContain('---');
    expect(md).toContain('# 2026-01 月次レポート');
    expect(md).toContain('0件');
    expect(md).not.toContain('## Action Items');
    expect(md).not.toContain('## トピックトレンド');
  });
});

// ============================================================================
// Dataview Frontmatter Fields
// ============================================================================

describe('Dataview frontmatter fields', () => {
  it('should include Dataview fields in weekly markdown', () => {
    const logs = createWeekOfLogs();
    const digest = aggregateWeeklyDigest(logs, '2026-01-20', '2026-01-26');
    const md = generateWeeklyMarkdown(digest);

    expect(md).toContain('period_start: 2026-01-20');
    expect(md).toContain('period_end: 2026-01-26');
    expect(md).toContain('total_duration_minutes:');
    expect(md).toContain('action_items_count:');
    expect(md).toContain('starred_count:');
    expect(md).toContain('sentiment_score:');
    expect(md).toContain('top_topics:');
  });

  it('should include Dataview fields in monthly markdown', () => {
    const logs = createWeekOfLogs();
    const digest = aggregateWeeklyDigest(logs, '2026-01-01', '2026-01-31');
    const md = generateMonthlyMarkdown(digest);

    expect(md).toContain('period_start: 2026-01-01');
    expect(md).toContain('period_end: 2026-01-31');
    expect(md).toContain('total_duration_minutes:');
    expect(md).toContain('action_items_count:');
    expect(md).toContain('starred_count:');
    expect(md).toContain('sentiment_score:');
  });

  it('should calculate correct sentiment score', () => {
    const logs = createWeekOfLogs();
    // 3 positive, 3 neutral, 1 mixed = (3 - 0) / 7 ≈ 0.43
    const digest = aggregateWeeklyDigest(logs, '2026-01-20', '2026-01-26');
    const md = generateWeeklyMarkdown(digest);

    expect(md).toContain('sentiment_score: 0.43');
  });

  it('should calculate duration in minutes', () => {
    const logs = createWeekOfLogs();
    const digest = aggregateWeeklyDigest(logs, '2026-01-20', '2026-01-26');
    const md = generateWeeklyMarkdown(digest);
    const totalMinutes = Math.round((3600 + 1200 + 300 + 2400 + 600 + 900 + 1800) / 60);

    expect(md).toContain(`total_duration_minutes: ${totalMinutes}`);
  });
});
