/**
 * Limitless Highlight Handler
 * Purpose: Process iOS Shortcut timestamp marks and extract ±30s context
 * Design: Stateful processing with retry logic (from Codex recommendation)
 */

import { z } from 'zod';
import type { Env } from '../types';
import { logWithTimestamp } from '../utils/logger';

// Request validation schema
const HighlightTriggerSchema = z.object({
  userId: z.string().min(1),
  timestamp: z.string().datetime(), // ISO 8601 format
  source: z.enum(['ios_shortcut', 'manual', 'automated']).optional().default('ios_shortcut'),
});

// Supabase processed_lifelogs schema (partial)
const ProcessedLifelogSchema = z.object({
  id: z.string().uuid(),
  limitless_id: z.string(),
  start_time: z.string().datetime(),
  end_time: z.string().datetime(),
  raw_contents: z.array(
    z.object({
      content: z.string(),
      speakerName: z.string().optional(),
      startTime: z.string().datetime().optional(),
      endTime: z.string().datetime().optional(),
      startOffsetMs: z.number().optional(),
      endOffsetMs: z.number().optional(),
    })
  ),
});

export async function handleHighlightTrigger(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    // 0. API Key authentication (Codex HIGH severity fix)
    // Accept API Key from header OR query parameter (iOS Shortcut fallback)
    const url = new URL(request.url);
    const apiKey = request.headers.get('X-API-Key') || url.searchParams.get('apiKey');

    if (!apiKey || apiKey !== env.HIGHLIGHT_API_KEY) {
      logWithTimestamp('warn', '[Highlight] Unauthorized access attempt', {
        hasApiKey: !!apiKey,
        hasHeader: !!request.headers.get('X-API-Key'),
        hasQuery: !!url.searchParams.get('apiKey'),
        ip: request.headers.get('CF-Connecting-IP') || 'unknown',
      });
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Unauthorized',
        }),
        {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    // 1. Parse and validate request (support both GET query params and POST body)
    // url already declared above for API key extraction
    let params: any;

    if (request.method === 'GET') {
      // GET: read from query parameters
      params = {
        userId: url.searchParams.get('userId'),
        timestamp: url.searchParams.get('timestamp') || new Date().toISOString(), // fallback to current time
        source: url.searchParams.get('source') || 'ios_shortcut',
      };
    } else {
      // POST: read from body
      params = await request.json();
    }

    const validated = HighlightTriggerSchema.parse(params);

    logWithTimestamp('info', '[Highlight] Trigger received', {
      userId: validated.userId,
      timestamp: validated.timestamp,
      source: validated.source,
    });

    // 2. Feature flag check (GLM condition: immediate shutdown capability)
    if (env.FEATURE_HIGHLIGHTS_ENABLED !== 'true') {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Highlight feature is currently disabled',
        }),
        {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    // 3. Extract timestamps for ±30s window
    const highlightTime = new Date(validated.timestamp);
    const startTime = new Date(highlightTime.getTime() - 30 * 1000);
    const endTime = new Date(highlightTime.getTime() + 30 * 1000);

    logWithTimestamp('info', '[Highlight] Extraction window', {
      highlightTime: highlightTime.toISOString(),
      startTime: startTime.toISOString(),
      endTime: endTime.toISOString(),
    });

    // 4. Query Supabase for lifelogs within the past hour (Codex: time drift safety)
    const oneHourAgo = new Date(highlightTime.getTime() - 60 * 60 * 1000);
    const supabaseUrl = env.SUPABASE_URL;
    const supabaseKey = env.SUPABASE_SERVICE_ROLE_KEY; // GLM condition: env var usage

    const lifelogsResponse = await fetch(
      `${supabaseUrl}/rest/v1/processed_lifelogs?start_time=gte.${oneHourAgo.toISOString()}&start_time=lte.${endTime.toISOString()}&order=start_time.desc&limit=10`,
      {
        headers: {
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`,
          'Content-Type': 'application/json',
        },
      }
    );

    // GLM condition: network error handling
    if (!lifelogsResponse.ok) {
      throw new Error(
        `Supabase query failed: ${lifelogsResponse.status} ${lifelogsResponse.statusText}`
      );
    }

    const lifelogsRaw = await lifelogsResponse.json();
    logWithTimestamp('info', '[Highlight] Lifelogs retrieved', {
      count: lifelogsRaw.length,
    });

    // 5. Find the lifelog that contains the highlight timestamp
    const targetLifelog = lifelogsRaw.find((log: any) => {
      const logStart = new Date(log.start_time);
      const logEnd = new Date(log.end_time);
      return highlightTime >= logStart && highlightTime <= logEnd;
    });

    if (!targetLifelog) {
      // No matching lifelog found - insert as "pending" for later resolution
      await insertPendingHighlight(env, {
        limitless_id: 'unknown',
        highlight_time: highlightTime.toISOString(),
        start_time: startTime.toISOString(),
        end_time: endTime.toISOString(),
        trigger_source: validated.source,
        processing_status: 'pending',
        error_message: 'No matching lifelog found',
      });

      return new Response(
        JSON.stringify({
          success: true,
          status: 'pending',
          message: 'Highlight marked, awaiting lifelog resolution',
        }),
        {
          status: 202,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    // 6. Validate and parse lifelog
    const lifelog = ProcessedLifelogSchema.parse(targetLifelog);

    // 7. Extract ±30s content blocks
    const relevantBlocks = lifelog.raw_contents.filter((block) => {
      if (!block.startTime || !block.endTime) return false;
      const blockStart = new Date(block.startTime);
      const blockEnd = new Date(block.endTime);
      return blockStart < endTime && blockEnd > startTime;
    });

    if (relevantBlocks.length === 0) {
      // Empty extraction - insert as "failed"
      await insertPendingHighlight(env, {
        limitless_id: lifelog.limitless_id,
        lifelog_id: lifelog.id,
        highlight_time: highlightTime.toISOString(),
        start_time: startTime.toISOString(),
        end_time: endTime.toISOString(),
        trigger_source: validated.source,
        processing_status: 'failed',
        error_message: 'No content blocks found in ±30s window',
      });

      return new Response(
        JSON.stringify({
          success: true,
          status: 'failed',
          message: 'No content found in extraction window',
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    // 8. Extract speaker and text
    const speakers = [
      ...new Set(
        relevantBlocks
          .map((b) => b.speakerName)
          .filter((s): s is string => !!s)
      ),
    ];
    const extractedText = relevantBlocks
      .map((b) => `${b.speakerName || 'Unknown'}: ${b.content}`)
      .join('\n');

    logWithTimestamp('info', '[Highlight] Content extracted', {
      speakers,
      textLength: extractedText.length,
    });

    // 9. Insert into lifelog_highlights table
    const highlightData = {
      lifelog_id: lifelog.id,
      limitless_id: lifelog.limitless_id,
      highlight_time: highlightTime.toISOString(),
      start_time: startTime.toISOString(),
      end_time: endTime.toISOString(),
      extracted_text: extractedText,
      speaker_name: speakers[0] || null,
      topics: [], // Will be filled by background processor
      trigger_source: validated.source,
      processing_status: 'completed',
      processed_at: new Date().toISOString(),
    };

    const insertResponse = await fetch(
      `${supabaseUrl}/rest/v1/lifelog_highlights`,
      {
        method: 'POST',
        headers: {
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`,
          'Content-Type': 'application/json',
          Prefer: 'return=representation',
        },
        body: JSON.stringify(highlightData),
      }
    );

    // GLM condition: error handling for insert
    if (!insertResponse.ok) {
      const errorText = await insertResponse.text();
      throw new Error(
        `Failed to insert highlight: ${insertResponse.status} ${errorText}`
      );
    }

    const insertedHighlight = await insertResponse.json();

    logWithTimestamp('info', '[Highlight] Successfully inserted', {
      highlightId: insertedHighlight[0]?.id,
    });

    return new Response(
      JSON.stringify({
        success: true,
        status: 'completed',
        highlight: insertedHighlight[0],
      }),
      {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    // GLM condition: comprehensive error handling
    logWithTimestamp('error', '[Highlight] Processing failed', {
      error: error instanceof Error ? error.message : String(error),
    });

    return new Response(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}

/**
 * Helper: Insert pending/failed highlight for later retry
 */
async function insertPendingHighlight(
  env: Env,
  data: {
    limitless_id?: string;
    lifelog_id?: string;
    highlight_time: string;
    start_time: string;
    end_time: string;
    trigger_source: string;
    processing_status: 'pending' | 'failed';
    error_message?: string;
  }
): Promise<void> {
  const supabaseUrl = env.SUPABASE_URL;
  const supabaseKey = env.SUPABASE_SERVICE_ROLE_KEY;

  await fetch(`${supabaseUrl}/rest/v1/lifelog_highlights`, {
    method: 'POST',
    headers: {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      ...data,
      retry_count: 0,
    }),
  });
}
