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

const AI_MODEL = '@cf/meta/llama-3.1-8b-instruct';
const MAX_CONTENT_LENGTH = 4000; // Limit input to avoid token overflow
const AI_TIMEOUT_MS = 15000; // 15 seconds

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
  lifelog: RawLifelogInput
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
    const result = await classifyAndSummarize(ai, textContent, lifelog.title);

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
  const truncatedContent = content.length > MAX_CONTENT_LENGTH
    ? content.substring(0, MAX_CONTENT_LENGTH) + '\n...(truncated)'
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
      AI_MODEL,
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
