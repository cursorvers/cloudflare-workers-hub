#!/usr/bin/env npx tsx
/**
 * Reprocess Lifelogs with GPT-4o-mini
 *
 * Re-processes existing Supabase records using GPT-4o-mini for higher-quality
 * classification, summarization, and insight extraction.
 *
 * Usage:
 *   npx tsx scripts/reprocess-lifelogs.ts
 *   npx tsx scripts/reprocess-lifelogs.ts --date 2026-01-26
 *   npx tsx scripts/reprocess-lifelogs.ts --dry-run
 *   npx tsx scripts/reprocess-lifelogs.ts --limit 3
 */

import { z } from 'zod';

// ============================================================================
// Configuration
// ============================================================================

const OPENAI_MODEL = 'gpt-4o-mini';
const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';
const MAX_CONTENT_LENGTH = 16000;
const TIMEOUT_MS = 30000;

// Parse CLI args
const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const dateArgIdx = args.indexOf('--date');
const specificDate = dateArgIdx >= 0 ? args[dateArgIdx + 1] : null;
const limitArgIdx = args.indexOf('--limit');
const maxRecords = limitArgIdx >= 0 ? parseInt(args[limitArgIdx + 1], 10) : 100;

// ============================================================================
// Environment
// ============================================================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
if (!OPENAI_API_KEY) {
  console.error('Missing OPENAI_API_KEY');
  process.exit(1);
}

// ============================================================================
// Types
// ============================================================================

interface LifelogRecord {
  id: string;
  limitless_id: string;
  title: string | null;
  classification: string;
  summary: string | null;
  raw_markdown: string | null;
  start_time: string;
  end_time: string;
}

const AIResponseSchema = z.object({
  classification: z.enum([
    'insight', 'meeting', 'casual', 'brainstorm', 'todo', 'reflection',
  ]),
  summary: z.string().min(1),
  keyInsights: z.array(z.string()).default([]),
  actionItems: z.array(z.string()).default([]),
  topics: z.array(z.string()).default([]),
  sentiment: z.enum(['positive', 'neutral', 'negative', 'mixed']),
  confidenceScore: z.number().min(0).max(1),
});

// ============================================================================
// Supabase Client
// ============================================================================

async function supabaseFetch<T>(
  table: string,
  query: string,
  method = 'GET',
  body?: unknown
): Promise<T> {
  const fullUrl = `${SUPABASE_URL}/rest/v1/${table}?${query}`;

  const headers: Record<string, string> = {
    'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY!}`,
    'apikey': SUPABASE_SERVICE_ROLE_KEY!,
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
// GPT-4o-mini Processing
// ============================================================================

const SYSTEM_PROMPT = `あなたは音声書き起こしの専門分析者です。Limitless Pendantで録音された音声テキストを分析します。

## 分析ルール

### 分類（classification）
以下から最も適切なカテゴリを1つ選択:
- insight: 重要な学び、アイデア、知見が含まれる（講演、教育的内容、技術解説）
- meeting: 会議、打ち合わせ、商談、イベント運営
- casual: 日常会話、移動中の環境音、アナウンス
- brainstorm: アイデア出し、企画検討
- todo: タスク・予定の確認、計画
- reflection: 振り返り、反省、感想

重要: 電車アナウンスや環境音は "casual"。内容が薄い短い録音も "casual"。

### 要約（summary）
- 3〜5文で**具体的に**記述（固有名詞、数字、キーワードを含める）
- 「〜についての会話が記録されています」のような空虚な要約は禁止
- 誰が何を話したか、核心的な内容を書く

### 重要な気づき（keyInsights）
- その録音から得られる**再利用可能な知見**のみ
- 「会話の進行と確認が重要」のような当たり前のことは書かない
- 具体的な数字・事実・判断基準を含める
- なければ空配列

### アクションアイテム（actionItems）
- 実際に誰かが「やる」と言及した具体的タスクのみ
- 「確認する」「考える」のような曖昧なものは除外
- 環境音やアナウンスからアクションを捏造しない
- なければ空配列

### トピック（topics）
- 議論された具体的なテーマ（固有名詞優先）
- 最大5個

必ず以下のJSON形式のみで回答（他のテキスト不要）:
{
  "classification": "カテゴリ名",
  "summary": "具体的な要約",
  "keyInsights": ["具体的な気づき"],
  "actionItems": ["具体的なアクション"],
  "topics": ["トピック"],
  "sentiment": "positive|neutral|negative|mixed",
  "confidenceScore": 0.0-1.0
}`;

async function processWithGPT(content: string, title?: string | null): Promise<z.infer<typeof AIResponseSchema>> {
  const truncated = content.length > MAX_CONTENT_LENGTH
    ? content.substring(0, MAX_CONTENT_LENGTH) + '\n...(truncated)'
    : content;

  const userPrompt = title
    ? `タイトル: ${title}\n\n書き起こし:\n${truncated}`
    : `書き起こし:\n${truncated}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(OPENAI_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: 1024,
        temperature: 0.1,
        response_format: { type: 'json_object' },
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI API error (${response.status}): ${errorText}`);
    }

    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const aiText = data.choices?.[0]?.message?.content;

    if (!aiText) {
      throw new Error('Empty response from OpenAI API');
    }

    // Parse JSON
    let jsonStr = aiText.trim();
    const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
      jsonStr = codeBlockMatch[1].trim();
    }
    const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No JSON found in response');
    }

    const raw = JSON.parse(jsonMatch[0]);
    return AIResponseSchema.parse(raw);
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log('=== Lifelog Reprocessing with GPT-4o-mini ===');
  console.log(`Mode: ${isDryRun ? 'DRY RUN' : 'LIVE'}`);
  console.log(`Date: ${specificDate || 'all'}`);
  console.log(`Limit: ${maxRecords}`);
  console.log('');

  // Fetch records
  let query = 'select=id,limitless_id,title,classification,summary,raw_markdown,start_time,end_time&order=start_time.asc';
  if (specificDate) {
    query += `&start_time=gte.${specificDate}T00:00:00Z&start_time=lt.${specificDate}T23:59:59Z`;
  }
  query += `&limit=${maxRecords}`;

  const records = await supabaseFetch<LifelogRecord[]>('processed_lifelogs', query);
  console.log(`Found ${records.length} records to reprocess`);

  let processed = 0;
  let failed = 0;

  for (const record of records) {
    const shortId = record.limitless_id.substring(0, 8);
    const time = new Date(record.start_time).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });

    if (!record.raw_markdown || record.raw_markdown.length < 20) {
      console.log(`  [SKIP] ${shortId} (${time}) - no/short content`);
      continue;
    }

    try {
      console.log(`  [${processed + 1}/${records.length}] ${shortId} (${time}) "${record.title || 'No title'}" ...`);
      console.log(`    OLD: ${record.classification} | ${(record.summary || '').substring(0, 50)}...`);

      const result = await processWithGPT(record.raw_markdown, record.title);

      console.log(`    NEW: ${result.classification} | ${result.summary.substring(0, 50)}...`);
      console.log(`    Insights: ${result.keyInsights.length}, Actions: ${result.actionItems.length}, Topics: ${result.topics.join(', ') || 'none'}`);

      if (!isDryRun) {
        // Update Supabase record
        await supabaseFetch(
          'processed_lifelogs',
          `id=eq.${record.id}`,
          'PATCH',
          {
            classification: result.classification,
            summary: result.summary,
            key_insights: result.keyInsights,
            action_items: result.actionItems,
            topics: result.topics,
            sentiment: result.sentiment,
            confidence_score: result.confidenceScore,
            obsidian_synced: false, // Mark for re-sync to Obsidian
          }
        );
        console.log(`    Updated in Supabase (obsidian_synced=false)`);
      }

      processed++;

      // Rate limit: ~3 requests per second for gpt-4o-mini
      await new Promise(resolve => setTimeout(resolve, 400));
    } catch (error) {
      console.error(`    [ERROR] ${shortId}: ${String(error)}`);
      failed++;
    }
  }

  console.log('');
  console.log(`=== Done ===`);
  console.log(`Processed: ${processed}, Failed: ${failed}, Skipped: ${records.length - processed - failed}`);

  if (isDryRun) {
    console.log('\n(Dry run - no changes made. Remove --dry-run to update Supabase)');
  } else {
    console.log('\nRun obsidian-sync.ts to regenerate Obsidian files with improved data.');
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
