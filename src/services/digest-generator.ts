/**
 * Digest Generator Service
 *
 * Pure functions that aggregate processed lifelogs into:
 * - Weekly digest: topic trends, sentiment, busyness, highlights
 * - Monthly digest: same aggregation over a calendar month
 * - Daily action items: unresolved action items across recordings
 *
 * No side effects. No external calls. Input → Output only.
 */

// ============================================================================
// Types
// ============================================================================

/** Lifelog record as returned from Supabase PostgREST */
export interface LifelogRecord {
  id: string;
  classification: string;
  summary: string | null;
  key_insights: unknown; // JSONB: string | string[]
  action_items: unknown; // JSONB: string | string[]
  topics: unknown;       // JSONB: string | string[]
  speakers: unknown;     // JSONB: string | string[]
  sentiment: string | null;
  title: string | null;
  start_time: string;
  end_time: string;
  duration_seconds: number | null;
  is_starred: boolean;
}

export interface TopicEntry {
  topic: string;
  count: number;
  classifications: string[];
}

export interface DailyStats {
  date: string;
  dayOfWeek: string;
  count: number;
  durationSeconds: number;
  classifications: Record<string, number>;
  sentiments: Record<string, number>;
}

export interface WeeklyDigest {
  periodStart: string;
  periodEnd: string;
  totalRecordings: number;
  totalDurationSeconds: number;
  classificationBreakdown: Record<string, number>;
  sentimentDistribution: Record<string, number>;
  topTopics: TopicEntry[];
  allActionItems: string[];
  allInsights: string[];
  starredCount: number;
  dailyStats: DailyStats[];
  highlights: Array<{
    title: string;
    classification: string;
    summary: string;
    time: string;
  }>;
}

export interface ActionItemReport {
  periodStart: string;
  periodEnd: string;
  totalItems: number;
  itemsByTopic: Record<string, string[]>;
  recentItems: Array<{
    item: string;
    date: string;
    classification: string;
  }>;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Safely parse a JSONB field from Supabase PostgREST.
 * May arrive as a JSON string or already-parsed array.
 */
export function parseJsonArray(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter((v) => typeof v === 'string');
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.filter((v: unknown) => typeof v === 'string') : [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Get JST date string (YYYY-MM-DD) from ISO datetime
 */
function toJSTDate(isoString: string): string {
  const date = new Date(isoString);
  return date.toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
}

/**
 * Get JST day of week label
 */
function toJSTDayOfWeek(isoString: string): string {
  const days = ['日', '月', '火', '水', '木', '金', '土'];
  const date = new Date(isoString);
  const jstDay = new Date(date.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
  return days[jstDay.getDay()];
}

/**
 * Format duration in Japanese
 */
function formatDuration(seconds: number): string {
  if (seconds <= 0) return '0分';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0 && minutes > 0) return `${hours}時間${minutes}分`;
  if (hours > 0) return `${hours}時間`;
  return `${minutes}分`;
}

/**
 * Classification label with emoji
 */
function classLabel(cls: string): string {
  const labels: Record<string, string> = {
    insight: '💡 インサイト',
    meeting: '🤝 ミーティング',
    casual: '💬 カジュアル',
    brainstorm: '🧠 ブレスト',
    todo: '✅ タスク',
    reflection: '🪞 振り返り',
    unprocessed: '📝 未処理',
  };
  return labels[cls] || cls;
}

/**
 * Get ISO week number (ISO 8601)
 */
function getISOWeek(dateStr: string): string {
  const date = new Date(dateStr + 'T00:00:00+09:00');
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

// ============================================================================
// Weekly Digest Aggregation
// ============================================================================

/**
 * Aggregate lifelogs into a weekly digest structure.
 * Input must be pre-filtered to the desired 7-day range.
 */
export function aggregateWeeklyDigest(
  lifelogs: LifelogRecord[],
  periodStart: string,
  periodEnd: string
): WeeklyDigest {
  const classificationBreakdown: Record<string, number> = {};
  const sentimentDistribution: Record<string, number> = {};
  const topicCounts = new Map<string, { count: number; classifications: Set<string> }>();
  const actionItemSet = new Set<string>();
  const insightSet = new Set<string>();
  const dailyMap = new Map<string, DailyStats>();
  let totalDuration = 0;
  let starredCount = 0;

  const highlights: WeeklyDigest['highlights'] = [];

  const meaningfulClassifications = new Set(['insight', 'meeting', 'brainstorm', 'todo', 'reflection']);

  for (const log of lifelogs) {
    // Classification counts
    const cls = log.classification;
    classificationBreakdown[cls] = (classificationBreakdown[cls] || 0) + 1;

    // Sentiment counts
    const sentiment = log.sentiment || 'unknown';
    sentimentDistribution[sentiment] = (sentimentDistribution[sentiment] || 0) + 1;

    // Duration
    if (log.duration_seconds) totalDuration += log.duration_seconds;

    // Starred
    if (log.is_starred) starredCount++;

    // Topics
    for (const topic of parseJsonArray(log.topics)) {
      if (topic.length <= 1) continue;
      const existing = topicCounts.get(topic);
      if (existing) {
        existing.count++;
        existing.classifications.add(cls);
      } else {
        topicCounts.set(topic, { count: 1, classifications: new Set([cls]) });
      }
    }

    // Action items (deduplicated)
    for (const item of parseJsonArray(log.action_items)) {
      if (item.length > 3) actionItemSet.add(item);
    }

    // Insights (deduplicated)
    for (const insight of parseJsonArray(log.key_insights)) {
      if (insight.length > 3) insightSet.add(insight);
    }

    // Daily stats
    const dateKey = toJSTDate(log.start_time);
    const existing = dailyMap.get(dateKey);
    if (existing) {
      existing.count++;
      existing.durationSeconds += log.duration_seconds || 0;
      existing.classifications[cls] = (existing.classifications[cls] || 0) + 1;
      existing.sentiments[sentiment] = (existing.sentiments[sentiment] || 0) + 1;
    } else {
      dailyMap.set(dateKey, {
        date: dateKey,
        dayOfWeek: toJSTDayOfWeek(log.start_time),
        count: 1,
        durationSeconds: log.duration_seconds || 0,
        classifications: { [cls]: 1 },
        sentiments: { [sentiment]: 1 },
      });
    }

    // Highlights (meaningful recordings with summary)
    if (meaningfulClassifications.has(cls) && log.summary) {
      highlights.push({
        title: log.title || 'Untitled',
        classification: cls,
        summary: log.summary,
        time: log.start_time,
      });
    }
  }

  // Sort topics by frequency
  const topTopics: TopicEntry[] = [...topicCounts.entries()]
    .map(([topic, data]) => ({
      topic,
      count: data.count,
      classifications: [...data.classifications],
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 15);

  // Sort daily stats by date
  const dailyStats = [...dailyMap.values()].sort((a, b) => a.date.localeCompare(b.date));

  return {
    periodStart,
    periodEnd,
    totalRecordings: lifelogs.length,
    totalDurationSeconds: totalDuration,
    classificationBreakdown,
    sentimentDistribution,
    topTopics,
    allActionItems: [...actionItemSet],
    allInsights: [...insightSet],
    starredCount,
    dailyStats,
    highlights: highlights.slice(0, 10), // Top 10 highlights
  };
}

// ============================================================================
// Action Item Aggregation
// ============================================================================

/**
 * Aggregate action items from lifelogs.
 * Groups by topic for context.
 */
export function aggregateActionItems(
  lifelogs: LifelogRecord[],
  periodStart: string,
  periodEnd: string
): ActionItemReport {
  const itemsByTopic: Record<string, Set<string>> = {};
  const recentItems: ActionItemReport['recentItems'] = [];

  for (const log of lifelogs) {
    const items = parseJsonArray(log.action_items);
    const topics = parseJsonArray(log.topics);
    const dateKey = toJSTDate(log.start_time);

    for (const item of items) {
      if (item.length <= 3) continue;

      // Add to recent items
      recentItems.push({
        item,
        date: dateKey,
        classification: log.classification,
      });

      // Group by topic
      const topicKey = topics.length > 0 ? topics[0] : '未分類';
      if (!itemsByTopic[topicKey]) {
        itemsByTopic[topicKey] = new Set();
      }
      itemsByTopic[topicKey].add(item);
    }
  }

  // Convert Sets to arrays
  const itemsByTopicArray: Record<string, string[]> = {};
  for (const [topic, items] of Object.entries(itemsByTopic)) {
    itemsByTopicArray[topic] = [...items];
  }

  return {
    periodStart,
    periodEnd,
    totalItems: recentItems.length,
    itemsByTopic: itemsByTopicArray,
    recentItems,
  };
}

// ============================================================================
// Markdown Generation
// ============================================================================

/**
 * Compute a sentiment score from -1 (all negative) to +1 (all positive)
 */
function computeSentimentScore(dist: Record<string, number>): number {
  const pos = dist['positive'] || 0;
  const neg = dist['negative'] || 0;
  const total = pos + neg + (dist['neutral'] || 0) + (dist['mixed'] || 0);
  if (total === 0) return 0;
  return Math.round(((pos - neg) / total) * 100) / 100;
}

/**
 * Generate Dataview-compatible frontmatter fields
 */
function buildDataviewFrontmatter(digest: WeeklyDigest, type: string, label: string): string[] {
  const topTags = digest.topTopics.slice(0, 5).map((t) => t.topic.replace(/\s+/g, '-'));
  const lines: string[] = [];

  lines.push('---');
  lines.push(`date: ${label}`);
  lines.push(`period: ${digest.periodStart} ~ ${digest.periodEnd}`);
  lines.push(`period_start: ${digest.periodStart}`);
  lines.push(`period_end: ${digest.periodEnd}`);
  lines.push('source: Limitless Pendant');
  lines.push(`type: ${type}`);
  lines.push(`recordings: ${digest.totalRecordings}`);
  lines.push(`total_duration: ${formatDuration(digest.totalDurationSeconds)}`);
  lines.push(`total_duration_minutes: ${Math.round(digest.totalDurationSeconds / 60)}`);
  lines.push(`action_items_count: ${digest.allActionItems.length}`);
  lines.push(`starred_count: ${digest.starredCount}`);
  lines.push(`sentiment_score: ${computeSentimentScore(digest.sentimentDistribution)}`);
  if (digest.topTopics.length > 0) {
    lines.push(`top_topics: [${digest.topTopics.slice(0, 5).map((t) => t.topic).join(', ')}]`);
  }
  lines.push(`tags: [pendant, ${type.split('-')[0]}${topTags.length > 0 ? ', ' + topTags.join(', ') : ''}]`);
  lines.push('---');

  return lines;
}

// ============================================================================
// Internal Helpers for Markdown Generation
// ============================================================================

/**
 * Configuration for generating digest markdown
 */
interface DigestMarkdownConfig {
  title: string;
  label: string;
  type: string;
  topicLimit: number;
  insightLimit: number;
  highlightLimit: number;
  breakdownTitle: string;
  breakdownColumns: string;
  breakdownRows: (digest: WeeklyDigest) => string[];
}

/**
 * Render summary statistics section
 */
function renderSummaryStats(digest: WeeklyDigest): string[] {
  const lines: string[] = [];
  const clsParts = Object.entries(digest.classificationBreakdown)
    .sort(([, a], [, b]) => b - a)
    .map(([cls, count]) => `${classLabel(cls)} ×${count}`);
  lines.push(`> ${digest.totalRecordings}件 | ${formatDuration(digest.totalDurationSeconds)} | ${clsParts.join(' / ')}`);
  if (digest.starredCount > 0) {
    lines.push(`> ⭐ スター付き: ${digest.starredCount}件`);
  }
  lines.push('');
  return lines;
}

/**
 * Render action items section
 */
function renderActionItems(digest: WeeklyDigest): string[] {
  const lines: string[] = [];
  if (digest.allActionItems.length > 0) {
    lines.push('## Action Items');
    lines.push('');
    for (const item of digest.allActionItems) {
      lines.push(`- [ ] ${item}`);
    }
    lines.push('');
  }
  return lines;
}

/**
 * Render topic trends section
 */
function renderTopicTrends(digest: WeeklyDigest, limit: number): string[] {
  const lines: string[] = [];
  if (digest.topTopics.length > 0) {
    lines.push('## トピックトレンド');
    lines.push('');
    lines.push('| # | トピック | 回数 | 分類 |');
    lines.push('|---|---------|------|------|');
    for (let i = 0; i < Math.min(digest.topTopics.length, limit); i++) {
      const t = digest.topTopics[i];
      const clsLabels = t.classifications.map((c) => classLabel(c)).join(', ');
      lines.push(`| ${i + 1} | ${t.topic} | ${t.count} | ${clsLabels} |`);
    }
    lines.push('');
  }
  return lines;
}

/**
 * Render key insights section
 */
function renderInsights(digest: WeeklyDigest, limit: number): string[] {
  const lines: string[] = [];
  if (digest.allInsights.length > 0) {
    lines.push('## Key Insights');
    lines.push('');
    for (const insight of digest.allInsights.slice(0, limit)) {
      lines.push(`> [!tip] ${insight}`);
    }
    lines.push('');
  }
  return lines;
}

/**
 * Render sentiment section
 */
function renderSentiment(digest: WeeklyDigest): string[] {
  const lines: string[] = [];
  const knownSentiments = ['positive', 'neutral', 'negative', 'mixed'];
  const hasSentiment = knownSentiments.some((s) => (digest.sentimentDistribution[s] || 0) > 0);
  if (hasSentiment) {
    lines.push('## 感情トレンド');
    lines.push('');
    const total = digest.totalRecordings || 1;
    const sentimentEmojis: Record<string, string> = {
      positive: '😊', neutral: '😐', negative: '😔', mixed: '🤔',
    };
    for (const s of knownSentiments) {
      const count = digest.sentimentDistribution[s] || 0;
      if (count === 0) continue;
      const pct = Math.round((count / total) * 100);
      const bar = '█'.repeat(Math.round(pct / 5)) + '░'.repeat(20 - Math.round(pct / 5));
      lines.push(`- ${sentimentEmojis[s]} ${s}: ${bar} ${pct}% (${count}件)`);
    }
    lines.push('');
  }
  return lines;
}

/**
 * Render period breakdown section (daily/weekly/monthly)
 */
function renderBreakdown(
  digest: WeeklyDigest,
  config: { title: string; columns: string; rows: (digest: WeeklyDigest) => string[] }
): string[] {
  const lines: string[] = [];
  if (digest.dailyStats.length > 0) {
    lines.push(`## ${config.title}`);
    lines.push('');
    lines.push(config.columns);
    lines.push(...config.rows(digest));
    lines.push('');
  }
  return lines;
}

/**
 * Render busyness section
 */
function renderBusyness(digest: WeeklyDigest): string[] {
  const lines: string[] = [];
  if (digest.dailyStats.length > 0) {
    const counts = digest.dailyStats.map((d) => d.count);
    const avgCount = counts.length > 0 ? counts.reduce((a, b) => a + b, 0) / counts.length : 0;
    const busiestDay = digest.dailyStats.reduce((a, b) => a.count > b.count ? a : b);
    const quietestDay = digest.dailyStats.reduce((a, b) => a.count < b.count ? a : b);

    lines.push('## 多忙度');
    lines.push('');
    const busyPct = Math.min(100, Math.round((avgCount / 30) * 100)); // 30 recordings/day = 100%
    const busyBar = '█'.repeat(Math.round(busyPct / 5)) + '░'.repeat(20 - Math.round(busyPct / 5));
    lines.push(`> 活動量: ${busyBar} ${busyPct}%`);
    lines.push(`> 最多: ${busiestDay.date} (${busiestDay.dayOfWeek}) ${busiestDay.count}件`);
    lines.push(`> 最少: ${quietestDay.date} (${quietestDay.dayOfWeek}) ${quietestDay.count}件`);
    lines.push(`> 平均: ${avgCount.toFixed(1)}件/日`);
    lines.push('');
  }
  return lines;
}

/**
 * Render highlights section
 */
function renderHighlights(digest: WeeklyDigest, limit: number): string[] {
  const lines: string[] = [];
  if (digest.highlights.length > 0) {
    lines.push('## ハイライト');
    lines.push('');
    for (const h of digest.highlights.slice(0, limit)) {
      const time = toJSTDate(h.time);
      lines.push(`- **${classLabel(h.classification)}** ${h.title} (${time})`);
      lines.push(`  ${h.summary.substring(0, 80)}${h.summary.length > 80 ? '...' : ''}`);
    }
    lines.push('');
  }
  return lines;
}

/**
 * Generate daily breakdown rows for weekly digest
 */
function generateDailyBreakdownRows(digest: WeeklyDigest): string[] {
  const lines: string[] = [];
  lines.push('|------|-------|------|---------|');
  for (const day of digest.dailyStats) {
    const topCls = Object.entries(day.classifications)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 2)
      .map(([cls, count]) => `${classLabel(cls)} ×${count}`)
      .join(', ');
    lines.push(`| ${day.date} (${day.dayOfWeek}) | ${day.count} | ${formatDuration(day.durationSeconds)} | ${topCls} |`);
  }
  return lines;
}

/**
 * Generate weekly breakdown rows for monthly digest
 */
function generateWeeklyBreakdownRows(digest: WeeklyDigest): string[] {
  const lines: string[] = [];
  lines.push('|-----|-------|------|---------|');

  const weeklyMap = new Map<string, { count: number; duration: number; classifications: Record<string, number> }>();
  for (const day of digest.dailyStats) {
    const week = getISOWeek(day.date);
    const existing = weeklyMap.get(week);
    if (existing) {
      existing.count += day.count;
      existing.duration += day.durationSeconds;
      for (const [cls, cnt] of Object.entries(day.classifications)) {
        existing.classifications[cls] = (existing.classifications[cls] || 0) + cnt;
      }
    } else {
      weeklyMap.set(week, {
        count: day.count,
        duration: day.durationSeconds,
        classifications: { ...day.classifications },
      });
    }
  }

  for (const [week, data] of [...weeklyMap.entries()].sort()) {
    const topCls = Object.entries(data.classifications)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 2)
      .map(([cls, count]) => `${classLabel(cls)} ×${count}`)
      .join(', ');
    lines.push(`| ${week} | ${data.count} | ${formatDuration(data.duration)} | ${topCls} |`);
  }

  return lines;
}

/**
 * Generate monthly breakdown rows for annual digest
 */
function generateMonthlyBreakdownRows(digest: WeeklyDigest): string[] {
  const lines: string[] = [];
  lines.push('|-----|-------|------|---------|');

  const monthlyMap = new Map<string, { count: number; duration: number; classifications: Record<string, number> }>();
  for (const day of digest.dailyStats) {
    const month = day.date.slice(0, 7); // YYYY-MM
    const existing = monthlyMap.get(month);
    if (existing) {
      existing.count += day.count;
      existing.duration += day.durationSeconds;
      for (const [cls, cnt] of Object.entries(day.classifications)) {
        existing.classifications[cls] = (existing.classifications[cls] || 0) + cnt;
      }
    } else {
      monthlyMap.set(month, {
        count: day.count,
        duration: day.durationSeconds,
        classifications: { ...day.classifications },
      });
    }
  }

  for (const [month, data] of [...monthlyMap.entries()].sort()) {
    const topCls = Object.entries(data.classifications)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 2)
      .map(([cls, count]) => `${classLabel(cls)} ×${count}`)
      .join(', ');
    lines.push(`| ${month} | ${data.count} | ${formatDuration(data.duration)} | ${topCls} |`);
  }

  return lines;
}

/**
 * Core template function for generating digest markdown.
 * Used by weekly/monthly/annual digest generators.
 */
function generateDigestMarkdown(digest: WeeklyDigest, config: DigestMarkdownConfig): string {
  const lines: string[] = buildDataviewFrontmatter(digest, config.type, config.label);
  lines.push('');
  lines.push(`# ${config.title}`);
  lines.push('');
  lines.push(...renderSummaryStats(digest));
  lines.push(...renderActionItems(digest));
  lines.push(...renderTopicTrends(digest, config.topicLimit));
  lines.push(...renderInsights(digest, config.insightLimit));
  lines.push(...renderSentiment(digest));
  lines.push(...renderBreakdown(digest, {
    title: config.breakdownTitle,
    columns: config.breakdownColumns,
    rows: config.breakdownRows,
  }));
  lines.push(...renderBusyness(digest));
  lines.push(...renderHighlights(digest, config.highlightLimit));
  return lines.join('\n');
}

// ============================================================================
// Public Markdown Generation Functions
// ============================================================================

/**
 * Generate Obsidian-compatible weekly digest markdown
 */
export function generateWeeklyMarkdown(digest: WeeklyDigest): string {
  const weekLabel = getISOWeek(digest.periodStart);
  return generateDigestMarkdown(digest, {
    title: `${weekLabel} 週次レポート`,
    label: weekLabel,
    type: 'weekly-digest',
    topicLimit: 15,
    insightLimit: 10,
    highlightLimit: 10,
    breakdownTitle: '日別アクティビティ',
    breakdownColumns: '| 日付 | 録音数 | 時間 | 主な活動 |',
    breakdownRows: generateDailyBreakdownRows,
  });
}

/**
 * Generate Obsidian-compatible monthly digest markdown.
 * Reuses WeeklyDigest data structure (period-agnostic aggregation).
 */
export function generateMonthlyMarkdown(digest: WeeklyDigest): string {
  const monthLabel = digest.periodStart.slice(0, 7); // YYYY-MM
  return generateDigestMarkdown(digest, {
    title: `${monthLabel} 月次レポート`,
    label: monthLabel,
    type: 'monthly-digest',
    topicLimit: 20,
    insightLimit: 15,
    highlightLimit: 15,
    breakdownTitle: '週別アクティビティ',
    breakdownColumns: '| 週 | 録音数 | 時間 | 主な活動 |',
    breakdownRows: generateWeeklyBreakdownRows,
  });
}

/**
 * Generate Obsidian-compatible annual digest markdown.
 * Reuses WeeklyDigest data structure (period-agnostic aggregation).
 * Includes monthly breakdown, top 30 topics, top 20 insights.
 */
export function generateAnnualMarkdown(digest: WeeklyDigest): string {
  const yearLabel = digest.periodStart.slice(0, 4); // YYYY
  return generateDigestMarkdown(digest, {
    title: `${yearLabel} 年次レポート`,
    label: yearLabel,
    type: 'annual-digest',
    topicLimit: 30,
    insightLimit: 20,
    highlightLimit: 20,
    breakdownTitle: '月別アクティビティ',
    breakdownColumns: '| 月 | 録音数 | 時間 | 主な活動 |',
    breakdownRows: generateMonthlyBreakdownRows,
  });
}

/**
 * Generate Obsidian-compatible action items markdown
 */
export function generateActionItemsMarkdown(report: ActionItemReport): string {
  const lines: string[] = [];
  const dateLabel = report.periodEnd;
  const topicKeys = Object.keys(report.itemsByTopic);

  // Frontmatter (Dataview-compatible)
  lines.push('---');
  lines.push(`date: ${dateLabel}`);
  lines.push(`period_start: ${report.periodStart}`);
  lines.push(`period_end: ${report.periodEnd}`);
  lines.push('source: Limitless Pendant');
  lines.push('type: action-items');
  lines.push(`total_items: ${report.totalItems}`);
  lines.push(`topic_count: ${topicKeys.length}`);
  lines.push('tags: [pendant, actions]');
  lines.push('---');
  lines.push('');
  lines.push(`# Action Items: ${dateLabel}`);
  lines.push('');
  lines.push(`> ${report.totalItems}件のアクションアイテム (${report.periodStart} ~ ${report.periodEnd})`);
  lines.push('');

  // By topic
  const topics = Object.entries(report.itemsByTopic).sort(([, a], [, b]) => b.length - a.length);
  for (const [topic, items] of topics) {
    lines.push(`## ${topic}`);
    lines.push('');
    for (const item of items) {
      lines.push(`- [ ] ${item}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
