#!/usr/bin/env npx tsx
/**
 * Obsidian Sync Script
 *
 * Syncs processed lifelogs from Supabase to Obsidian vault as daily digest files.
 *
 * Pipeline: Supabase (processed_lifelogs) → Daily Digest .md → Obsidian Vault
 *
 * Output: /Users/masayuki/Obsidian Project Kit for Market/04_Journals/Pendant/YYYY/MM/YYYY-MM-DD.md
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
 * - Meaningful recordings: summary + insights (no transcript)
 * - Casual recordings: timeline only
 */
function buildDailyDigest(date: string, lifelogs: ProcessedLifelog[]): string {
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
  const lines: string[] = [
    '---',
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

  // Process each date
  const syncedIds: string[] = [];

  for (const [date, logs] of byDate) {
    const [year, month] = date.split('-');
    const dirPath = path.join(pendantDir, year, month);
    const filePath = path.join(dirPath, `${date}.md`);

    console.log(`  📝 ${date}: ${logs.length} recording(s) → ${filePath}`);

    // Build markdown
    const markdown = buildDailyDigest(date, logs);

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

  console.log(`\n✅ Sync complete! ${syncedIds.length} lifelogs synced to Obsidian.`);
}

// Run
main().catch((error) => {
  console.error('❌ Sync failed:', error);
  process.exit(1);
});
