/**
 * Lifelog Processor Service
 *
 * Processes Limitless lifelogs using Workers AI for:
 * - Classification (insight, meeting, casual, brainstorm, todo, reflection)
 * - Summarization (2-3 sentences in Japanese)
 * - Key insight extraction
 * - Action item extraction
 * - Topic extraction
 * - Sentiment analysis
 *
 * Design constraints:
 * - Never discard data: all recordings stored with classification label
 * - Fallback: classification='unprocessed' when AI unavailable
 */

import { z } from 'zod';
import { safeLog } from '../utils/log-sanitizer';

// ============================================================================
// Types
// ============================================================================

/** Classification categories for lifelogs */
export type Classification =
  | 'insight'
  | 'meeting'
  | 'casual'
  | 'brainstorm'
  | 'todo'
  | 'reflection'
  | 'unprocessed'
  | 'pending';

/** Sentiment labels */
export type Sentiment = 'positive' | 'neutral' | 'negative' | 'mixed';

/** Input: raw lifelog data from Limitless API */
export interface RawLifelogInput {
  id: string;
  title?: string;
  markdown?: string;
  contents?: Array<{
    content: string;
    type: string;
    speakerName?: string;
    startTime?: string;
    endTime?: string;
  }>;
  startTime: string;
  endTime: string;
  isStarred?: boolean;
}

/** Output: processed lifelog ready for Supabase storage */
export interface ProcessedLifelog {
  classification: Classification;
  summary: string | null;
  keyInsights: string[];
  actionItems: string[];
  topics: string[];
  speakers: string[];
  sentiment: Sentiment | null;
  confidenceScore: number | null;
}

// Zod schema for AI response validation
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
// Constants
// ============================================================================

const WORKERS_AI_MODEL = '@cf/meta/llama-3.1-8b-instruct';
const OPENAI_MODEL = 'gpt-4o-mini';
const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';
const MAX_CONTENT_LENGTH_WORKERS = 4000; // Workers AI: small model limit
const MAX_CONTENT_LENGTH_OPENAI = 16000; // OpenAI: much larger context
const AI_TIMEOUT_MS = 15000; // 15 seconds
const OPENAI_TIMEOUT_MS = 30000; // 30 seconds (external API)

// ============================================================================
// Main Processing Function
// ============================================================================

/**
 * Process a single lifelog using Workers AI
 *
 * @param ai - Workers AI binding
 * @param lifelog - Raw lifelog from Limitless API
 * @returns Processed result with classification, summary, etc.
 *
 * On AI failure, returns classification='unprocessed' with null fields.
 * Data is never discarded.
 */
export async function processLifelog(
  ai: Ai,
  lifelog: RawLifelogInput,
  openaiApiKey?: string
): Promise<ProcessedLifelog> {
  // Extract speakers from content blocks
  const speakers = extractSpeakers(lifelog);

  // Build text content for AI processing
  const textContent = buildTextContent(lifelog);

  // Skip AI processing if content is too short
  if (textContent.length < 20) {
    safeLog.info('[Processor] Content too short for AI processing', {
      lifelogId: lifelog.id,
      length: textContent.length,
    });
    return {
      classification: 'casual',
      summary: null,
      keyInsights: [],
      actionItems: [],
      topics: [],
      speakers,
      sentiment: null,
      confidenceScore: null,
    };
  }

  try {
    // Use OpenAI (GPT-4o-mini) if API key is available, else fall back to Workers AI
    const result = openaiApiKey
      ? await classifyAndSummarizeOpenAI(openaiApiKey, textContent, lifelog.title)
      : await classifyAndSummarize(ai, textContent, lifelog.title);

    return {
      ...result,
      speakers,
    };
  } catch (error) {
    safeLog.error('[Processor] AI processing failed, marking as unprocessed', {
      lifelogId: lifelog.id,
      error: String(error),
    });

    // Fallback: never discard data
    return {
      classification: 'unprocessed',
      summary: null,
      keyInsights: [],
      actionItems: [],
      topics: [],
      speakers,
      sentiment: null,
      confidenceScore: null,
    };
  }
}

// ============================================================================
// Internal Functions
// ============================================================================

/**
 * Call Workers AI for classification and summarization
 */
async function classifyAndSummarize(
  ai: Ai,
  content: string,
  title?: string
): Promise<Omit<ProcessedLifelog, 'speakers'>> {
  // Truncate content if too long
  const truncatedContent = content.length > MAX_CONTENT_LENGTH_WORKERS
    ? content.substring(0, MAX_CONTENT_LENGTH_WORKERS) + '\n...(truncated)'
    : content;

  const systemPrompt = `あなたは音声録音のテキストを分析するアシスタントです。
以下のテキストを分析し、JSON形式で結果を返してください。

分類カテゴリ:
- insight: 重要な気づき、アイデア、学び
- meeting: 会議、打ち合わせ、商談
- casual: 日常会話、雑談
- brainstorm: ブレインストーミング、企画
- todo: タスク、やること、予定
- reflection: 振り返り、反省、感想

必ず以下のJSON形式で回答してください（他のテキストは不要）:
{
  "classification": "カテゴリ名",
  "summary": "2-3文の要約（日本語）",
  "keyInsights": ["重要な気づき1", "重要な気づき2"],
  "actionItems": ["アクション1", "アクション2"],
  "topics": ["トピック1", "トピック2"],
  "sentiment": "positive|neutral|negative|mixed",
  "confidenceScore": 0.0-1.0
}`;

  const userPrompt = title
    ? `タイトル: ${title}\n\n内容:\n${truncatedContent}`
    : `内容:\n${truncatedContent}`;

  // Call Workers AI with timeout
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);

  try {
    const response = await (ai.run as (model: string, input: unknown, options?: unknown) => Promise<unknown>)(
      WORKERS_AI_MODEL,
      {
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: 512,
        temperature: 0.1, // Low temperature for consistent classification
      },
      { signal: controller.signal }
    );

    clearTimeout(timeoutId);

    const aiText = (response as { response?: string })?.response;
    if (!aiText) {
      throw new Error('Empty response from Workers AI');
    }

    // Parse JSON from AI response
    const parsed = parseAIResponse(aiText);

    safeLog.info('[Processor] AI processing successful', {
      classification: parsed.classification,
      confidenceScore: parsed.confidenceScore,
    });

    return parsed;
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
}

/**
 * Call OpenAI API (GPT-4o-mini) for higher-quality classification and summarization
 */
async function classifyAndSummarizeOpenAI(
  apiKey: string,
  content: string,
  title?: string
): Promise<Omit<ProcessedLifelog, 'speakers'>> {
  const truncatedContent = content.length > MAX_CONTENT_LENGTH_OPENAI
    ? content.substring(0, MAX_CONTENT_LENGTH_OPENAI) + '\n...(truncated)'
    : content;

  const systemPrompt = `あなたは音声書き起こしの専門分析者です。Limitless Pendantで録音された音声テキストを分析します。

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

  const userPrompt = title
    ? `タイトル: ${title}\n\n書き起こし:\n${truncatedContent}`
    : `書き起こし:\n${truncatedContent}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);

  try {
    const response = await fetch(OPENAI_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
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

    const parsed = parseAIResponse(aiText);

    safeLog.info('[Processor] OpenAI processing successful', {
      model: OPENAI_MODEL,
      classification: parsed.classification,
      confidenceScore: parsed.confidenceScore,
    });

    return parsed;
  } catch (error) {
    clearTimeout(timeoutId);
    // If OpenAI fails, don't silently fall through — let the caller handle it
    throw error;
  }
}

/**
 * Parse and validate AI response JSON
 */
function parseAIResponse(text: string): Omit<ProcessedLifelog, 'speakers'> {
  // Try to extract JSON from the response
  // AI might wrap JSON in markdown code blocks
  let jsonStr = text.trim();

  // Remove markdown code block if present
  const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    jsonStr = codeBlockMatch[1].trim();
  }

  // Try to find JSON object in the response
  const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('No JSON found in AI response');
  }

  const raw = JSON.parse(jsonMatch[0]);
  const validated = AIResponseSchema.parse(raw);

  return {
    classification: validated.classification,
    summary: validated.summary,
    keyInsights: validated.keyInsights,
    actionItems: validated.actionItems,
    topics: validated.topics,
    sentiment: validated.sentiment,
    confidenceScore: validated.confidenceScore,
  };
}

/**
 * Extract unique speaker names from lifelog content blocks
 */
function extractSpeakers(lifelog: RawLifelogInput): string[] {
  if (!lifelog.contents) return [];

  const speakerSet = new Set<string>();

  for (const block of lifelog.contents) {
    if (block.speakerName && block.speakerName !== 'Unknown') {
      speakerSet.add(block.speakerName);
    }
  }

  return [...speakerSet];
}

/**
 * Build text content from lifelog for AI processing
 * Prioritizes markdown, falls back to content blocks
 */
function buildTextContent(lifelog: RawLifelogInput): string {
  // Use markdown if available
  if (lifelog.markdown && lifelog.markdown.length > 0) {
    return lifelog.markdown;
  }

  // Fall back to content blocks
  if (lifelog.contents && lifelog.contents.length > 0) {
    return lifelog.contents
      .filter((c) => c.type === 'blockquote')
      .map((c) => {
        const speaker = c.speakerName || 'Unknown';
        return `${speaker}: ${c.content}`;
      })
      .join('\n');
  }

  return '';
}

// ============================================================================
// Phase 1: Highlight Processing (New Feature)
// ============================================================================

/**
 * Process a highlight extraction (±30s window) using Workers AI
 *
 * Purpose: Extract topics and generate summary for a short time segment
 * Use case: User-marked highlights from iOS Shortcut
 *
 * @param ai - Workers AI binding
 * @param highlightText - Transcription of ±30s window (60s total)
 * @param openaiApiKey - Optional OpenAI API key for higher quality
 * @returns Topics and summary for the highlight segment
 *
 * GLM condition: Edge case handling for network errors and invalid responses
 */
export async function processHighlight(
  ai: Ai,
  highlightText: string,
  openaiApiKey?: string
): Promise<{
  topics: string[];
  summary: string;
}> {
  // Validate input
  if (!highlightText || highlightText.length < 10) {
    return {
      topics: [],
      summary: '内容が短すぎます',
    };
  }

  try {
    // For short segments (60s), Workers AI is sufficient - no need for expensive GPT-4o-mini
    const systemPrompt = `あなたは音声録音のハイライト部分（30秒前後）を分析するアシスタントです。
短い区間から主要なトピックと要約を抽出してください。

必ず以下のJSON形式で回答してください:
{
  "topics": ["トピック1", "トピック2", "トピック3"],
  "summary": "1-2文の要約（日本語）"
}`;

    const userPrompt = `以下のテキストから、トピックと要約を抽出してください:\n\n${highlightText}`;

    // Call Workers AI with timeout (GLM condition: network error handling)
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);

    try {
      const response = await (ai.run as (model: string, input: unknown, options?: unknown) => Promise<unknown>)(
        WORKERS_AI_MODEL,
        {
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          max_tokens: 256,
          temperature: 0.2,
        },
        { signal: controller.signal }
      );

      clearTimeout(timeoutId);

      const aiText = (response as { response?: string })?.response;
      if (!aiText) {
        // GLM condition: Invalid response handling
        throw new Error('Empty response from Workers AI');
      }

      // Parse JSON from AI response
      const parsed = parseHighlightResponse(aiText);

      safeLog.info('[Processor] Highlight processing successful', {
        topics: parsed.topics,
        summaryLength: parsed.summary.length,
      });

      return parsed;
    } catch (error) {
      clearTimeout(timeoutId);

      // GLM condition: Network error fallback
      if (error instanceof Error && error.name === 'AbortError') {
        safeLog.error('[Processor] Highlight processing timeout', {
          error: 'Request aborted after 15s',
        });
        return {
          topics: [],
          summary: 'AI処理がタイムアウトしました',
        };
      }

      throw error;
    }
  } catch (error) {
    // GLM condition: Comprehensive error handling
    safeLog.error('[Processor] Highlight processing failed', {
      error: error instanceof Error ? error.message : String(error),
    });

    // Return safe fallback instead of throwing
    return {
      topics: [],
      summary: 'ハイライトの処理中にエラーが発生しました',
    };
  }
}

/**
 * Parse and validate highlight AI response
 * Simpler schema than full lifelog processing
 */
function parseHighlightResponse(text: string): {
  topics: string[];
  summary: string;
} {
  let jsonStr = text.trim();

  // Remove markdown code block if present
  const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    jsonStr = codeBlockMatch[1].trim();
  }

  // Try to find JSON object in the response
  const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('No JSON found in highlight AI response');
  }

  const raw = JSON.parse(jsonMatch[0]) as {
    topics?: unknown;
    summary?: unknown;
  };

  // Simple validation (no Zod schema needed for this simple case)
  const topics = Array.isArray(raw.topics)
    ? raw.topics.filter((t): t is string => typeof t === 'string')
    : [];

  const summary = typeof raw.summary === 'string' && raw.summary.length > 0
    ? raw.summary
    : 'ハイライトの要約';

  return { topics, summary };
}
