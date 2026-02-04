#!/usr/bin/env npx tsx
/**
 * Obsidian Sync Script
 *
 * Phase 1: Syncs processed lifelogs from Supabase → daily digest .md files
 * Phase 2: Syncs digest reports (weekly/monthly/daily actions) from Supabase → Obsidian
 *
 * Pipeline:
 *   Supabase (processed_lifelogs) → 04_Journals/Pendant/YYYY/MM/YYYY-MM-DD.md
 *   Supabase (digest_reports)     → 04_Journals/Pendant/Weekly/YYYY-Wxx.md
 *                                 → 04_Journals/Pendant/Monthly/YYYY-MM.md
 *                                 → 04_Journals/Pendant/Actions/YYYY-MM-DD.md
 *                                 → 04_Journals/Pendant/Annual/YYYY.md
 *
 * Usage:
 *   npx tsx scripts/obsidian-sync.ts
 *   npx tsx scripts/obsidian-sync.ts --dry-run
 *   npx tsx scripts/obsidian-sync.ts --date 2026-01-25
 *
 * Environment variables:
 *   SUPABASE_URL - Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY - Supabase service role key
 *   OBSIDIAN_VAULT_PATH - Override default vault path (optional)
 */

import * as fs from 'fs';
import * as path from 'path';
import { config } from 'dotenv';

// Load environment variables from .env file
config();

// ============================================================================
// Configuration
// ============================================================================

const DEFAULT_VAULT_PATH = '/Users/masayuki/Obsidian Project Kit for Market';
const PENDANT_DIR = '04_Journals/Pendant';

// Parse CLI args
const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const dateArgIdx = args.indexOf('--date');
const specificDate = dateArgIdx >= 0 ? args[dateArgIdx + 1] : null;

// ============================================================================
// Types
// ============================================================================

interface DigestReport {
  id: string;
  type: 'weekly' | 'monthly' | 'daily_actions' | 'annual';
  period_start: string;
  period_end: string;
  content: unknown;
  markdown: string;
  obsidian_synced: boolean;
  slides_url: string | null;
  created_at: string;
}

interface ProcessedLifelog {
  id: string;
  limitless_id: string;
  classification: string;
  summary: string | null;
  key_insights: string[];
  action_items: string[];
  topics: string[];
  speakers: string[];
  sentiment: string | null;
  title: string | null;
  start_time: string;
  end_time: string;
  duration_seconds: number | null;
  is_starred: boolean;
  raw_markdown: string | null;
}

interface LifelogHighlight {
  id: string;
  limitless_id: string;
  title: string;
  content: string;
  speaker: string | null;
  topics: string[];
  timestamp: string;
  user_reflection: string | null; // Phase 4: User's emotional reflection
  user_action_plan: string | null; // Phase 4: Action plan for applying insights
  created_at: string;
}

// ============================================================================
// Supabase Client (minimal, for Node.js)
// ============================================================================

async function supabaseFetch<T>(
  url: string,
  serviceRoleKey: string,
  table: string,
  query: string,
  method = 'GET',
  body?: unknown
): Promise<T> {
  const fullUrl = `${url}/rest/v1/${table}?${query}`;

  const headers: Record<string, string> = {
    'Authorization': `Bearer ${serviceRoleKey}`,
    'apikey': serviceRoleKey,
    'Content-Type': 'application/json',
  };

  if (method === 'PATCH') {
    headers['Prefer'] = 'return=representation';
  }

  const response = await fetch(fullUrl, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Supabase ${method} ${table} failed (${response.status}): ${errorText}`);
  }

  if (response.status === 204) {
    return [] as unknown as T;
  }

  return response.json() as T;
}

// ============================================================================
// Obsidian Markdown Generation
// ============================================================================

/**
 * Format duration in human-readable form
 */
function formatDuration(seconds: number | null): string {
  if (!seconds || seconds <= 0) return '';
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (minutes === 0) return `${secs}秒`;
  if (secs === 0) return `${minutes}分`;
  return `${minutes}分${secs}秒`;
}

/**
 * Format time from ISO string to HH:MM (JST)
 */
function formatTimeJST(isoString: string): string {
  const date = new Date(isoString);
  return date.toLocaleTimeString('ja-JP', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Tokyo',
  });
}

/**
 * Get JST date string (YYYY-MM-DD) from ISO datetime
 */
function getJSTDate(isoString: string): string {
  const date = new Date(isoString);
  return date.toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' }); // sv-SE gives YYYY-MM-DD
}

/**
 * Format date string (YYYY-MM-DD) to Japanese format (YYYY年M月D日)
 */
function formatJapaneseDate(dateStr: string): string {
  const [year, month, day] = dateStr.split('-');
  return `${year}年${parseInt(month, 10)}月${parseInt(day, 10)}日`;
}

/**
 * Classification label in Japanese
 */
function classificationLabel(classification: string): string {
  const labels: Record<string, string> = {
    insight: '💡 インサイト',
    meeting: '🤝 ミーティング',
    casual: '💬 カジュアル',
    brainstorm: '🧠 ブレスト',
    todo: '✅ タスク',
    reflection: '🪞 振り返り',
    unprocessed: '📝 未処理',
    pending: '⏳ 処理待ち',
  };
  return labels[classification] || `📄 ${classification}`;
}

/**
 * Sentiment emoji
 */
function sentimentEmoji(sentiment: string | null): string {
  if (!sentiment) return '';
  const emojis: Record<string, string> = {
    positive: '😊',
    neutral: '😐',
    negative: '😔',
    mixed: '🤔',
  };
  return emojis[sentiment] || '';
}

/**
 * Safely parse a JSONB field that may arrive as a string or array from Supabase REST API
 */
function parseJsonArray(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Classifications considered "meaningful" — shown with full detail in the digest
 */
const MEANINGFUL_CLASSIFICATIONS = new Set(['insight', 'meeting', 'brainstorm', 'todo', 'reflection']);

/**
 * Build daily digest markdown from lifelogs
 *
 * Compact format:
 * - Day summary with stats
 * - Aggregated action items & insights (deduplicated)
 * - User Highlights (from lifelog_highlights table)
 * - Meaningful recordings: summary + insights (no transcript)
 * - Casual recordings: timeline only
 */
function buildDailyDigest(date: string, lifelogs: ProcessedLifelog[], highlights: LifelogHighlight[]): string {
  const sorted = [...lifelogs].sort(
    (a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime()
  );

  // Aggregate stats
  const classificationCounts: Record<string, number> = {};
  let totalDuration = 0;
  const allTopics = new Set<string>();
  const allActionItems: string[] = [];
  const allInsights: string[] = [];

  for (const log of sorted) {
    const cls = log.classification;
    classificationCounts[cls] = (classificationCounts[cls] || 0) + 1;
    if (log.duration_seconds) totalDuration += log.duration_seconds;
    parseJsonArray(log.topics).forEach((t) => allTopics.add(t));
    allActionItems.push(...parseJsonArray(log.action_items));
    allInsights.push(...parseJsonArray(log.key_insights));
  }

  const meaningful = sorted.filter((l) => MEANINGFUL_CLASSIFICATIONS.has(l.classification));
  const casual = sorted.filter((l) => !MEANINGFUL_CLASSIFICATIONS.has(l.classification));

  // Frontmatter
  const tags = [...allTopics]
    .filter((t) => t.length > 1)
    .slice(0, 10)
    .map((t) => t.replace(/\s+/g, '-'));

  // Generate Japanese date format for title (e.g., "2026年2月1日")
  const japaneseDate = formatJapaneseDate(date);
  const [, month, day] = date.split('-');
  const shortDate = `${parseInt(month, 10)}月${parseInt(day, 10)}日`;

  const lines: string[] = [
    '---',
    `title: 📅 ${japaneseDate} - 生活ログ`,
    `aliases: [${shortDate}, ${month}/${day}]`,
    `date: ${date}`,
    'source: Limitless Pendant',
    `recordings: ${sorted.length}`,
    totalDuration > 0 ? `total_duration: ${formatDuration(totalDuration)}` : '',
    tags.length > 0 ? `tags: [pendant, ${tags.join(', ')}]` : 'tags: [pendant]',
    '---',
    '',
    `# ${date} - Pendant Log`,
    '',
  ].filter(Boolean);

  // === Day Stats ===
  const statParts: string[] = [];
  for (const [cls, count] of Object.entries(classificationCounts)) {
    statParts.push(`${classificationLabel(cls)} ×${count}`);
  }
  lines.push(`> ${sorted.length}件の録音 | ${formatDuration(totalDuration) || '不明'} | ${statParts.join(' / ')}`);
  lines.push('');

  // === Action Items (aggregated) ===
  const uniqueActions = [...new Set(allActionItems)].filter((a) => a.length > 3);
  if (uniqueActions.length > 0) {
    lines.push('## Action Items');
    lines.push('');
    for (const item of uniqueActions) {
      lines.push(`- [ ] ${item}`);
    }
    lines.push('');
  }

  // === Key Insights (aggregated, deduplicated) ===
  const uniqueInsights = [...new Set(allInsights)].filter((i) => i.length > 3);
  if (uniqueInsights.length > 0) {
    lines.push('## Key Insights');
    lines.push('');
    for (const insight of uniqueInsights) {
      lines.push(`> [!tip] ${insight}`);
    }
    lines.push('');
  }

  // === User Highlights (from lifelog_highlights table) ===
  if (highlights.length > 0) {
    lines.push('## User Highlights');
    lines.push('');

    // Sort highlights by timestamp
    const sortedHighlights = [...highlights].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );

    for (const highlight of sortedHighlights) {
      const time = formatTimeJST(highlight.timestamp);
      const speaker = highlight.speaker || '大田原正幸';

      lines.push(`### ${time} — ${highlight.title}`);
      lines.push(`*Speaker: ${speaker}*`);
      lines.push('');
      lines.push(`> [!tip] ハイライト`);
      lines.push(`> ${highlight.content}`);
      lines.push('');

      const topics = parseJsonArray(highlight.topics);
      if (topics.length > 0) {
        lines.push(`**Topics**: ${topics.join(', ')}`);
        lines.push('');
      }

      lines.push(`#### 📋 振り返り（必須）`);
      lines.push('');

      // Display existing reflections or prompts
      if (highlight.user_reflection || highlight.user_action_plan) {
        // User has already filled in reflections
        if (highlight.user_reflection) {
          lines.push(`**1. どう感じたか？**`);
          lines.push(`${highlight.user_reflection}`);
          lines.push('');
        }
        if (highlight.user_action_plan) {
          lines.push(`**2. 今後の仕事でどう生かすか？**`);
          lines.push(`${highlight.user_action_plan}`);
          lines.push('');
        }
      } else {
        // Prompt user to fill in reflections
        lines.push(`> [!note] このハイライトについて、必ず以下の2つを記録してください`);
        lines.push('');
        lines.push(`**1. どう感じたか？**`);
        lines.push(`<!-- 感情・印象・違和感など、率直な感想を記録 -->`);
        lines.push(`- `);
        lines.push('');
        lines.push(`**2. 今後の仕事でどう生かすか？**`);
        lines.push(`<!-- 具体的なアクション・適用方法・実験したいこと -->`);
        lines.push(`- `);
        lines.push('');
      }
      lines.push('---');
      lines.push('');
    }
  }

  // === Meaningful Recordings (detail view) ===
  if (meaningful.length > 0) {
    lines.push('## Highlights');
    lines.push('');

    for (const log of meaningful) {
      const time = formatTimeJST(log.start_time);
      const duration = formatDuration(log.duration_seconds);
      const title = log.title || 'Untitled';
      const starred = log.is_starred ? ' ⭐' : '';

      lines.push(`### ${classificationLabel(log.classification)} ${title}${starred}`);
      lines.push(`*${time} (${duration || '不明'})*`);
      lines.push('');

      if (log.summary) {
        lines.push(log.summary);
        lines.push('');
      }

      const topics = parseJsonArray(log.topics);
      if (topics.length > 0) {
        lines.push(`**Topics**: ${topics.join(', ')}`);
        lines.push('');
      }

      const insights = parseJsonArray(log.key_insights);
      if (insights.length > 0) {
        for (const insight of insights) {
          lines.push(`- 💡 ${insight}`);
        }
        lines.push('');
      }

      const actions = parseJsonArray(log.action_items);
      if (actions.length > 0) {
        for (const item of actions) {
          lines.push(`- [ ] ${item}`);
        }
        lines.push('');
      }

      lines.push('---');
      lines.push('');
    }
  }

  // === Casual recordings (compact list) ===
  if (casual.length > 0) {
    lines.push('## Other');
    lines.push('');
    for (const log of casual) {
      const time = formatTimeJST(log.start_time);
      const title = log.title || 'Untitled';
      const dur = formatDuration(log.duration_seconds);
      const summary = log.summary ? ` — ${log.summary.substring(0, 60)}` : '';
      lines.push(`- **${time}** ${title} (${dur || '?'})${summary}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ============================================================================
// Digest Reports Sync
// ============================================================================

/**
 * Get ISO week number from a date string
 */
function getISOWeekNumber(dateStr: string): string {
  const date = new Date(dateStr);
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

/**
 * Determine the output file path for a digest report
 */
function getDigestOutputPath(pendantDir: string, report: DigestReport): string {
  if (report.type === 'weekly') {
    const weekLabel = getISOWeekNumber(report.period_start);
    return path.join(pendantDir, 'Weekly', `${weekLabel}.md`);
  }
  if (report.type === 'monthly') {
    // Monthly → Monthly/YYYY-MM.md (using period_start month)
    const monthLabel = report.period_start.slice(0, 7); // YYYY-MM
    return path.join(pendantDir, 'Monthly', `${monthLabel}.md`);
  }
  if (report.type === 'annual') {
    // Annual → Annual/YYYY.md (using period_start year)
    const yearLabel = report.period_start.slice(0, 4); // YYYY
    return path.join(pendantDir, 'Annual', `${yearLabel}.md`);
  }
  // daily_actions → Actions/YYYY-MM-DD.md (using period_end date in JST)
  const dateStr = getJSTDate(report.period_end);
  return path.join(pendantDir, 'Actions', `${dateStr}.md`);
}

/**
 * Sync unsynced digest reports from Supabase to Obsidian
 */
async function syncDigestReports(
  supabaseUrl: string,
  serviceRoleKey: string,
  pendantDir: string
): Promise<number> {
  console.log('\n📊 Fetching unsynced digest reports from Supabase...');

  const reports = await supabaseFetch<DigestReport[]>(
    supabaseUrl,
    serviceRoleKey,
    'digest_reports',
    'select=id,type,period_start,period_end,markdown,obsidian_synced,slides_url,created_at&obsidian_synced=eq.false&order=period_start.asc'
  );

  if (reports.length === 0) {
    console.log('✅ No unsynced digest reports found.');
    return 0;
  }

  console.log(`📊 Found ${reports.length} unsynced digest report(s)`);

  const syncedIds: string[] = [];

  for (const report of reports) {
    const filePath = getDigestOutputPath(pendantDir, report);
    const dirPath = path.dirname(filePath);
    const typeLabels: Record<string, string> = { weekly: 'Weekly Digest', monthly: 'Monthly Digest', daily_actions: 'Daily Actions', annual: 'Annual Digest' };
    const typeLabel = typeLabels[report.type] || report.type;

    console.log(`  📝 ${typeLabel} (${report.period_start.slice(0, 10)}) → ${filePath}`);

    if (!report.markdown || report.markdown.trim().length === 0) {
      console.log(`    ⚠️ Empty markdown, skipping`);
      continue;
    }

    // Inject slides_url into frontmatter and body if available
    let finalMarkdown = report.markdown;
    if (report.slides_url) {
      // Add slides_url to frontmatter (before closing ---)
      finalMarkdown = finalMarkdown.replace(
        /^(---\n[\s\S]*?)(---)/m,
        `$1slides_url: "${report.slides_url}"\n$2`
      );
      // Add a link after the first heading
      finalMarkdown = finalMarkdown.replace(
        /^(# .+)$/m,
        `$1\n\n> [Google Slides](${report.slides_url})`
      );
    }

    if (!isDryRun) {
      fs.mkdirSync(dirPath, { recursive: true });
      const existed = fs.existsSync(filePath);
      fs.writeFileSync(filePath, finalMarkdown, 'utf-8');
      console.log(existed ? `    ↻ Updated existing file` : `    ✨ Created new file`);
      if (report.slides_url) {
        console.log(`    🎯 Slides: ${report.slides_url}`);
      }
      syncedIds.push(report.id);
    } else {
      console.log(`    (dry run - skipped)`);
      console.log(`    Preview (first 200 chars): ${finalMarkdown.substring(0, 200)}...`);
      if (report.slides_url) {
        console.log(`    🎯 Slides: ${report.slides_url}`);
      }
    }
  }

  // Mark as synced in Supabase
  if (!isDryRun && syncedIds.length > 0) {
    console.log(`\n🔄 Marking ${syncedIds.length} digest report(s) as synced...`);

    for (let i = 0; i < syncedIds.length; i += 50) {
      const batch = syncedIds.slice(i, i + 50);
      const idFilter = batch.map((id) => `"${id}"`).join(',');

      await supabaseFetch(
        supabaseUrl,
        serviceRoleKey,
        'digest_reports',
        `id=in.(${idFilter})`,
        'PATCH',
        {
          obsidian_synced: true,
          obsidian_synced_at: new Date().toISOString(),
        }
      );

      console.log(`  ✅ Batch ${Math.floor(i / 50) + 1}: ${batch.length} report(s) marked`);
    }
  }

  return syncedIds.length;
}

// ============================================================================
// Dataview Query Guide Generation
// ============================================================================

/**
 * Generate a Dataview Query Guide markdown file for Obsidian.
 * Contains DQL examples for querying weekly/monthly/annual/action-items digests.
 */
function generateDataviewGuide(pendantDir: string): void {
  const guidePath = path.join(pendantDir, 'Dataview-Query-Guide.md');

  const content = `---
type: guide
source: Limitless Pendant
tags: [pendant, dataview, guide]
---

# Pendant Dataview Query Guide

このガイドは Obsidian Dataview プラグインで Pendant データを活用するための DQL サンプル集です。

## 基本クエリ

### 全ダイジェスト一覧

\`\`\`dataview
TABLE period_start AS "開始", period_end AS "終了", recordings AS "録音数", total_duration AS "時間"
FROM "04_Journals/Pendant"
WHERE type
SORT period_start DESC
\`\`\`

### 週次ダイジェスト一覧

\`\`\`dataview
TABLE period_start AS "開始", recordings AS "録音数", total_duration AS "時間", sentiment_score AS "感情"
FROM "04_Journals/Pendant/Weekly"
WHERE type = "weekly-digest"
SORT period_start DESC
\`\`\`

### 月次ダイジェスト一覧

\`\`\`dataview
TABLE period_start AS "開始", recordings AS "録音数", total_duration AS "時間", sentiment_score AS "感情"
FROM "04_Journals/Pendant/Monthly"
WHERE type = "monthly-digest"
SORT period_start DESC
\`\`\`

### 年次ダイジェスト一覧

\`\`\`dataview
TABLE period_start AS "開始", recordings AS "録音数", total_duration AS "時間", sentiment_score AS "感情"
FROM "04_Journals/Pendant/Annual"
WHERE type = "annual-digest"
SORT period_start DESC
\`\`\`

## アクションアイテム

### 未完了アクションアイテム

\`\`\`dataview
TABLE total_items AS "件数", topic_count AS "トピック数"
FROM "04_Journals/Pendant/Actions"
WHERE type = "action-items"
SORT period_end DESC
LIMIT 10
\`\`\`

### アクションアイテムが多い週

\`\`\`dataview
TABLE action_items_count AS "AI件数", recordings AS "録音数", total_duration AS "時間"
FROM "04_Journals/Pendant/Weekly"
WHERE type = "weekly-digest" AND action_items_count > 5
SORT action_items_count DESC
\`\`\`

## 感情分析

### 感情スコアが高い週（ポジティブ）

\`\`\`dataview
TABLE sentiment_score AS "感情", recordings AS "録音数", top_topics AS "トピック"
FROM "04_Journals/Pendant/Weekly"
WHERE type = "weekly-digest" AND sentiment_score > 0.3
SORT sentiment_score DESC
\`\`\`

### 感情スコアが低い週（ネガティブ）

\`\`\`dataview
TABLE sentiment_score AS "感情", recordings AS "録音数", top_topics AS "トピック"
FROM "04_Journals/Pendant/Weekly"
WHERE type = "weekly-digest" AND sentiment_score < -0.1
SORT sentiment_score ASC
\`\`\`

### 月次感情トレンド

\`\`\`dataview
TABLE sentiment_score AS "感情", recordings AS "録音数", total_duration_minutes AS "分"
FROM "04_Journals/Pendant/Monthly"
WHERE type = "monthly-digest"
SORT period_start ASC
\`\`\`

## 活動量分析

### 録音数が多い週 (Top 10)

\`\`\`dataview
TABLE recordings AS "録音数", total_duration AS "時間", starred_count AS "スター"
FROM "04_Journals/Pendant/Weekly"
WHERE type = "weekly-digest"
SORT recordings DESC
LIMIT 10
\`\`\`

### スター付き録音が多い期間

\`\`\`dataview
TABLE starred_count AS "スター", recordings AS "録音数", top_topics AS "トピック"
FROM "04_Journals/Pendant"
WHERE starred_count > 0
SORT starred_count DESC
\`\`\`

### 月別録音時間（分）

\`\`\`dataview
TABLE total_duration_minutes AS "分", recordings AS "録音数", sentiment_score AS "感情"
FROM "04_Journals/Pendant/Monthly"
WHERE type = "monthly-digest"
SORT period_start ASC
\`\`\`

## 複合クエリ

### 特定トピックを含むダイジェスト

\`\`\`dataview
TABLE type AS "種別", period_start AS "開始", recordings AS "録音数"
FROM "04_Journals/Pendant"
WHERE contains(top_topics, "Cloudflare Workers")
SORT period_start DESC
\`\`\`

### 今月のサマリー

\`\`\`dataview
TABLE type AS "種別", recordings AS "録音数", action_items_count AS "AI件数"
FROM "04_Journals/Pendant"
WHERE period_start >= date(today).year + "-" + padleft(date(today).month, 2, "0") + "-01"
SORT period_start DESC
\`\`\`

## Inline クエリ例

日々のノートに埋め込む例:

- 今週の録音数: \`= this.recordings\`
- 感情スコア: \`= this.sentiment_score\`
- トップトピック: \`= this.top_topics\`
- アクションアイテム数: \`= this.action_items_count\`

## フロントマッターフィールド一覧

| フィールド | 型 | 説明 | 対象 |
|-----------|-----|------|------|
| \`type\` | string | ダイジェスト種別 | 全て |
| \`period_start\` | date | 期間開始日 | 全て |
| \`period_end\` | date | 期間終了日 | 全て |
| \`recordings\` | number | 録音件数 | weekly/monthly/annual |
| \`total_duration\` | string | 合計時間（表示用） | weekly/monthly/annual |
| \`total_duration_minutes\` | number | 合計時間（分） | weekly/monthly/annual |
| \`action_items_count\` | number | AI件数 | weekly/monthly/annual |
| \`starred_count\` | number | スター付き件数 | weekly/monthly/annual |
| \`sentiment_score\` | number | 感情スコア (-1〜+1) | weekly/monthly/annual |
| \`top_topics\` | list | 上位トピック | weekly/monthly/annual |
| \`total_items\` | number | アクションアイテム総数 | actions |
| \`topic_count\` | number | トピック数 | actions |
`;

  const dirPath = path.dirname(guidePath);
  fs.mkdirSync(dirPath, { recursive: true });
  fs.writeFileSync(guidePath, content, 'utf-8');
  console.log(`  📖 Dataview Query Guide → ${guidePath}`);
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  console.log('🔄 Obsidian Sync starting...');

  // Get config from environment
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const vaultPath = process.env.OBSIDIAN_VAULT_PATH || DEFAULT_VAULT_PATH;

  if (!supabaseUrl || !serviceRoleKey) {
    console.error('❌ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables');
    process.exit(1);
  }

  // Verify vault path exists
  const pendantDir = path.join(vaultPath, PENDANT_DIR);
  if (!fs.existsSync(vaultPath)) {
    console.error(`❌ Vault path does not exist: ${vaultPath}`);
    process.exit(1);
  }

  if (isDryRun) {
    console.log('🏃 DRY RUN mode - no files will be written');
  }

  // Build query for unsynced lifelogs
  let query = 'obsidian_synced=eq.false&classification=neq.pending&order=start_time.asc';

  if (specificDate) {
    // Sync specific date (JST range)
    const dateStart = new Date(`${specificDate}T00:00:00+09:00`).toISOString();
    const dateEnd = new Date(`${specificDate}T23:59:59+09:00`).toISOString();
    query += `&start_time=gte.${dateStart}&start_time=lte.${dateEnd}`;
    console.log(`📅 Syncing specific date: ${specificDate}`);
  }

  // Fetch unsynced lifelogs from Supabase
  console.log('📥 Fetching unsynced lifelogs from Supabase...');

  const lifelogs = await supabaseFetch<ProcessedLifelog[]>(
    supabaseUrl,
    serviceRoleKey,
    'processed_lifelogs',
    `select=id,limitless_id,classification,summary,key_insights,action_items,topics,speakers,sentiment,title,start_time,end_time,duration_seconds,is_starred,raw_markdown&${query}`
  );

  if (lifelogs.length === 0) {
    console.log('✅ No unsynced lifelogs found. Everything up to date.');
    return;
  }

  console.log(`📊 Found ${lifelogs.length} unsynced lifelogs`);

  // Group by JST date
  const byDate = new Map<string, ProcessedLifelog[]>();

  for (const log of lifelogs) {
    const date = getJSTDate(log.start_time);
    const existing = byDate.get(date) || [];
    existing.push(log);
    byDate.set(date, existing);
  }

  console.log(`📁 Grouped into ${byDate.size} date(s)`);

  // Fetch highlights for all dates (optimized: single query instead of N+1)
  console.log('📌 Fetching user highlights from Supabase...');
  const allDates = Array.from(byDate.keys());
  const highlightsByDate = new Map<string, LifelogHighlight[]>();

  if (allDates.length > 0) {
    // Calculate date range (min to max)
    const sortedDates = [...allDates].sort();
    const minDate = new Date(`${sortedDates[0]}T00:00:00+09:00`).toISOString();
    const maxDate = new Date(`${sortedDates[sortedDates.length - 1]}T23:59:59+09:00`).toISOString();

    // Fetch all highlights in one query
    const allHighlights = await supabaseFetch<LifelogHighlight[]>(
      supabaseUrl,
      serviceRoleKey,
      'lifelog_highlights',
      `select=id,limitless_id,title,content,speaker,topics,timestamp,user_reflection,user_action_plan,created_at&timestamp=gte.${minDate}&timestamp=lte.${maxDate}&order=timestamp.asc`
    );

    // Group highlights by date in memory
    for (const highlight of allHighlights) {
      const highlightDate = new Date(highlight.timestamp).toLocaleString('ja-JP', {
        timeZone: 'Asia/Tokyo',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      }).split('/').join('-');

      const existing = highlightsByDate.get(highlightDate) || [];
      existing.push(highlight);
      highlightsByDate.set(highlightDate, existing);
    }

    console.log(`  📌 Total ${allHighlights.length} highlight(s) across ${allDates.length} date(s)`);
  }

  // Process each date
  const syncedIds: string[] = [];

  for (const [date, logs] of byDate) {
    const [year, month] = date.split('-');
    const dirPath = path.join(pendantDir, year, month);
    const filePath = path.join(dirPath, `${date}.md`);

    const highlights = highlightsByDate.get(date) || [];
    console.log(`  📝 ${date}: ${logs.length} recording(s) + ${highlights.length} highlight(s) → ${filePath}`);

    // Build markdown
    const markdown = buildDailyDigest(date, logs, highlights);

    if (!isDryRun) {
      // Create directory if needed
      fs.mkdirSync(dirPath, { recursive: true });

      // Check if file already exists (append new recordings)
      if (fs.existsSync(filePath)) {
        // Read existing file and merge
        const existing = fs.readFileSync(filePath, 'utf-8');
        // Replace the entire file with new content (includes all recordings for the day)
        fs.writeFileSync(filePath, markdown, 'utf-8');
        console.log(`    ↻ Updated existing file`);
      } else {
        fs.writeFileSync(filePath, markdown, 'utf-8');
        console.log(`    ✨ Created new file`);
      }

      // Collect synced IDs
      syncedIds.push(...logs.map((l) => l.id));
    } else {
      console.log(`    (dry run - skipped)`);
      console.log(`    Preview (first 200 chars): ${markdown.substring(0, 200)}...`);
    }
  }

  // Mark as synced in Supabase
  if (!isDryRun && syncedIds.length > 0) {
    console.log(`\n🔄 Marking ${syncedIds.length} lifelogs as synced in Supabase...`);

    // Update in batches of 50
    for (let i = 0; i < syncedIds.length; i += 50) {
      const batch = syncedIds.slice(i, i + 50);
      const idFilter = batch.map((id) => `"${id}"`).join(',');

      await supabaseFetch(
        supabaseUrl,
        serviceRoleKey,
        'processed_lifelogs',
        `id=in.(${idFilter})`,
        'PATCH',
        {
          obsidian_synced: true,
          obsidian_synced_at: new Date().toISOString(),
        }
      );

      console.log(`  ✅ Batch ${Math.floor(i / 50) + 1}: ${batch.length} records marked`);
    }
  }

  console.log(`\n✅ Lifelogs sync complete! ${syncedIds.length} lifelogs synced to Obsidian.`);

  // === Phase 2: Sync Digest Reports ===
  const digestCount = await syncDigestReports(supabaseUrl, serviceRoleKey, pendantDir);

  console.log(`\n🎉 All done! ${syncedIds.length} lifelogs + ${digestCount} digest report(s) synced.`);

  // === Generate Dataview Query Guide ===
  if (!isDryRun) {
    generateDataviewGuide(pendantDir);
  }
}

// Run
main().catch((error) => {
  console.error('❌ Sync failed:', error);
  process.exit(1);
});
