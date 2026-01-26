/**
 * Limitless.ai API Integration Service
 *
 * Provides integration with Limitless.ai API for syncing Pendant voice recordings.
 * Features:
 * - Fetch recent lifelogs from Limitless.ai
 * - Download audio recordings as Ogg Opus
 * - Sync lifelogs to knowledge service
 * - Automatic retry logic with exponential backoff
 * - Pagination support
 */

import { z } from 'zod';
import { Env } from '../types';
import { safeLog } from '../utils/log-sanitizer';
import { storeKnowledge, KnowledgeItem } from './knowledge';

// ============================================================================
// Zod Schemas
// ============================================================================

/**
 * Configuration schema for Limitless API
 */
const LimitlessConfigSchema = z.object({
  apiKey: z.string().min(1, 'API key is required'),
  syncIntervalMinutes: z.number().min(1).max(1440).optional().default(60), // 1-1440 minutes
  maxAgeHours: z.number().min(1).max(168).optional().default(24), // 1-168 hours (7 days)
});

export type LimitlessConfig = z.infer<typeof LimitlessConfigSchema>;

/**
 * Lifelog content block (from Limitless API)
 */
const LifelogContentSchema = z.object({
  content: z.string(),
  type: z.enum(['heading1', 'heading2', 'blockquote']),
  speakerName: z.string().optional(),
  startTime: z.string().optional(),
  endTime: z.string().optional(),
  startOffsetMs: z.number().optional(),
  endOffsetMs: z.number().optional(),
});

/**
 * Lifelog schema (from Limitless API - actual response format)
 */
const LifelogSchema = z.object({
  id: z.string(),
  title: z.string().optional(),
  markdown: z.string().optional(),
  contents: z.array(LifelogContentSchema).optional(),
  startTime: z.string(),
  endTime: z.string(),
  isStarred: z.boolean().optional(),
  updatedAt: z.string().optional(),
});

export type Lifelog = z.infer<typeof LifelogSchema>;

/**
 * Options for fetching lifelogs
 */
const GetLifelogsOptionsSchema = z.object({
  limit: z.number().min(1).max(10).optional().default(10), // API beta: max 10
  cursor: z.string().optional(),
  startTime: z.string().optional(),
  endTime: z.string().optional(),
});

export type GetLifelogsOptions = z.infer<typeof GetLifelogsOptionsSchema>;

/**
 * Audio download options
 */
const DownloadAudioOptionsSchema = z.object({
  startTime: z.string().datetime(),
  endTime: z.string().datetime(),
  format: z.enum(['ogg', 'mp3']).optional().default('ogg'),
});

export type DownloadAudioOptions = z.infer<typeof DownloadAudioOptionsSchema>;

/**
 * Sync options
 */
const SyncOptionsSchema = z.object({
  userId: z.string().min(1, 'User ID is required'),
  maxAgeHours: z.number().min(1).max(168).optional().default(24),
  includeAudio: z.boolean().optional().default(false),
});

export type SyncOptions = z.infer<typeof SyncOptionsSchema>;

// ============================================================================
// Constants
// ============================================================================

const LIMITLESS_API_BASE_URL = 'https://api.limitless.ai/v1';
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY = 1000; // 1 second
const MAX_AUDIO_DURATION = 7200; // 2 hours in seconds
const REQUEST_TIMEOUT = 30000; // 30 seconds

// ============================================================================
// Public API Functions
// ============================================================================

/**
 * Get recent lifelogs from Limitless API
 *
 * @param apiKey - Limitless API key
 * @param options - Optional filters and pagination
 * @returns Array of lifelogs and optional cursor for pagination
 */
export async function getRecentLifelogs(
  apiKey: string,
  options?: GetLifelogsOptions
): Promise<{ lifelogs: Lifelog[]; cursor?: string }> {
  // Validate inputs
  const validatedOptions = options
    ? GetLifelogsOptionsSchema.parse(options)
    : GetLifelogsOptionsSchema.parse({});

  safeLog.info('[Limitless] Fetching recent lifelogs', {
    limit: validatedOptions.limit,
    hasCursor: !!validatedOptions.cursor,
  });

  try {
    // Build query parameters
    const params = new URLSearchParams({
      limit: validatedOptions.limit.toString(),
    });

    if (validatedOptions.cursor) {
      params.append('cursor', validatedOptions.cursor);
    }
    if (validatedOptions.startTime) {
      params.append('start_time', validatedOptions.startTime);
    }
    if (validatedOptions.endTime) {
      params.append('end_time', validatedOptions.endTime);
    }

    // Make API request with retry logic
    const response = await fetchWithRetry(
      `${LIMITLESS_API_BASE_URL}/lifelogs?${params.toString()}`,
      {
        method: 'GET',
        headers: {
          'X-API-Key': apiKey,
          'Content-Type': 'application/json',
        },
      }
    );

    const rawData = await response.json();

    // Parse actual API response: { data: { lifelogs: [...] }, meta: { lifelogs: { nextCursor } } }
    const lifelogsArray = rawData?.data?.lifelogs || rawData?.lifelogs || [];
    const lifelogs = z.array(LifelogSchema).parse(lifelogsArray);
    const cursor = rawData?.meta?.lifelogs?.nextCursor || rawData?.cursor;

    safeLog.info('[Limitless] Successfully fetched lifelogs', {
      count: lifelogs.length,
      hasMore: !!cursor,
    });

    return {
      lifelogs,
      cursor,
    };
  } catch (error) {
    safeLog.error('[Limitless] Failed to fetch lifelogs', {
      error: String(error),
    });
    throw new Error(`Failed to fetch lifelogs: ${String(error)}`);
  }
}

/**
 * Get a specific lifelog by ID
 *
 * @param apiKey - Limitless API key
 * @param lifelogId - Lifelog ID
 * @returns Lifelog data
 */
export async function getLifelog(apiKey: string, lifelogId: string): Promise<Lifelog> {
  if (!lifelogId) {
    throw new Error('Lifelog ID is required');
  }

  safeLog.info('[Limitless] Fetching lifelog', { lifelogId });

  try {
    const response = await fetchWithRetry(`${LIMITLESS_API_BASE_URL}/lifelogs/${lifelogId}`, {
      method: 'GET',
      headers: {
        'X-API-Key': apiKey,
        'Content-Type': 'application/json',
      },
    });

    const data = await response.json();
    const lifelog = LifelogSchema.parse(data);

    safeLog.info('[Limitless] Successfully fetched lifelog', { lifelogId });

    return lifelog;
  } catch (error) {
    safeLog.error('[Limitless] Failed to fetch lifelog', {
      lifelogId,
      error: String(error),
    });
    throw new Error(`Failed to fetch lifelog: ${String(error)}`);
  }
}

/**
 * Download audio recording from Limitless
 *
 * @param apiKey - Limitless API key
 * @param options - Audio download options (startTime, endTime, format)
 * @returns Audio data as ArrayBuffer
 */
export async function downloadAudio(
  apiKey: string,
  options: DownloadAudioOptions
): Promise<ArrayBuffer> {
  // Validate inputs
  const validatedOptions = DownloadAudioOptionsSchema.parse(options);

  // Calculate duration
  const startMs = new Date(validatedOptions.startTime).getTime();
  const endMs = new Date(validatedOptions.endTime).getTime();
  const durationSeconds = (endMs - startMs) / 1000;

  // Validate duration (max 2 hours as per Limitless API docs)
  if (durationSeconds > MAX_AUDIO_DURATION) {
    throw new Error(
      `Audio duration exceeds maximum allowed (${MAX_AUDIO_DURATION} seconds). Requested: ${durationSeconds} seconds`
    );
  }

  if (durationSeconds <= 0) {
    throw new Error('Invalid time range: endTime must be after startTime');
  }

  safeLog.info('[Limitless] Downloading audio', {
    startTime: validatedOptions.startTime,
    endTime: validatedOptions.endTime,
    durationSeconds,
    format: validatedOptions.format,
  });

  try {
    // Build query parameters
    const params = new URLSearchParams({
      start_time: validatedOptions.startTime,
      end_time: validatedOptions.endTime,
      format: validatedOptions.format,
    });

    // Make API request with retry logic
    const response = await fetchWithRetry(
      `${LIMITLESS_API_BASE_URL}/audio?${params.toString()}`,
      {
        method: 'GET',
        headers: {
          'X-API-Key': apiKey,
        },
      }
    );

    const audioBuffer = await response.arrayBuffer();

    safeLog.info('[Limitless] Successfully downloaded audio', {
      size: audioBuffer.byteLength,
      format: validatedOptions.format,
    });

    return audioBuffer;
  } catch (error) {
    safeLog.error('[Limitless] Failed to download audio', {
      error: String(error),
    });
    throw new Error(`Failed to download audio: ${String(error)}`);
  }
}

/**
 * Sync lifelogs to knowledge service
 *
 * @param env - Cloudflare Workers environment
 * @param apiKey - Limitless API key
 * @param options - Sync options (userId, maxAgeHours, includeAudio)
 * @returns Number of lifelogs synced
 */
export async function syncToKnowledge(
  env: Env,
  apiKey: string,
  options: SyncOptions
): Promise<{ synced: number; skipped: number; errors: string[] }> {
  // Validate inputs
  const validatedOptions = SyncOptionsSchema.parse(options);

  safeLog.info('[Limitless] Starting sync to knowledge service', {
    userId: validatedOptions.userId,
    maxAgeHours: validatedOptions.maxAgeHours,
    includeAudio: validatedOptions.includeAudio,
  });

  const errors: string[] = [];
  let synced = 0;
  let skipped = 0;

  try {
    // Calculate time range
    const endTime = new Date();
    const startTime = new Date(endTime.getTime() - validatedOptions.maxAgeHours * 60 * 60 * 1000);

    // Fetch lifelogs in batches
    let cursor: string | undefined = undefined;
    let hasMore = true;

    while (hasMore) {
      const result = await getRecentLifelogs(apiKey, {
        limit: 10, // API beta max
        cursor,
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
      });

      // Process each lifelog
      for (const lifelog of result.lifelogs) {
        try {
          // Skip if no meaningful content (no markdown and no contents)
          if (!lifelog.markdown && (!lifelog.contents || lifelog.contents.length === 0)) {
            safeLog.info('[Limitless] Skipping lifelog without content', {
              lifelogId: lifelog.id,
            });
            skipped++;
            continue;
          }

          // Extract transcript from blockquote contents
          const transcript = lifelog.contents
            ?.filter((c) => c.type === 'blockquote')
            .map((c) => `${c.speakerName || 'Unknown'}: ${c.content}`)
            .join('\n') || '';

          // Prepare knowledge item
          const knowledgeItem: KnowledgeItem = {
            userId: validatedOptions.userId,
            source: 'manual',
            type: 'voice_note',
            title: lifelog.title || `Pendant Recording - ${new Date(lifelog.startTime).toLocaleString()}`,
            content: lifelog.markdown || transcript,
            createdAt: lifelog.startTime,
          };

          // Download and store audio if requested
          if (validatedOptions.includeAudio) {
            try {
              const audioBuffer = await downloadAudio(apiKey, {
                startTime: lifelog.startTime,
                endTime: lifelog.endTime,
                format: 'ogg',
              });

              // Store audio in R2 if available
              if (env.AUDIO_STAGING) {
                const audioPath = `limitless/${validatedOptions.userId}/${lifelog.id}.ogg`;
                await env.AUDIO_STAGING.put(audioPath, audioBuffer, {
                  httpMetadata: {
                    contentType: 'audio/ogg',
                  },
                  customMetadata: {
                    userId: validatedOptions.userId,
                    lifelogId: lifelog.id,
                  },
                });

                knowledgeItem.audioPath = audioPath;

                safeLog.info('[Limitless] Stored audio in R2', {
                  lifelogId: lifelog.id,
                  audioPath,
                  size: audioBuffer.byteLength,
                });
              }
            } catch (audioError) {
              safeLog.warn('[Limitless] Failed to download/store audio, continuing without it', {
                lifelogId: lifelog.id,
                error: String(audioError),
              });
              // Continue without audio
            }
          }

          // Store in knowledge service
          await storeKnowledge(env, knowledgeItem);

          synced++;

          safeLog.info('[Limitless] Synced lifelog to knowledge', {
            lifelogId: lifelog.id,
            userId: validatedOptions.userId,
          });
        } catch (itemError) {
          const errorMsg = `Failed to sync lifelog ${lifelog.id}: ${String(itemError)}`;
          safeLog.error('[Limitless] Failed to sync individual lifelog', {
            lifelogId: lifelog.id,
            error: String(itemError),
          });
          errors.push(errorMsg);
        }
      }

      // Check if there are more pages
      cursor = result.cursor;
      hasMore = !!cursor;
    }

    safeLog.info('[Limitless] Sync completed', {
      synced,
      skipped,
      errors: errors.length,
    });

    return { synced, skipped, errors };
  } catch (error) {
    safeLog.error('[Limitless] Sync failed', {
      error: String(error),
    });
    throw new Error(`Sync to knowledge failed: ${String(error)}`);
  }
}

// ============================================================================
// Internal Helper Functions
// ============================================================================

/**
 * Fetch with automatic retry on failure
 */
async function fetchWithRetry(
  url: string,
  options: RequestInit,
  attempt = 1
): Promise<Response> {
  try {
    // Add timeout to fetch
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    // Check for HTTP errors
    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(
        `HTTP ${response.status}: ${response.statusText}. Body: ${errorBody.substring(0, 200)}`
      );
    }

    return response;
  } catch (error) {
    if (attempt >= MAX_RETRIES) {
      safeLog.error('[Limitless] Max retries exceeded', {
        url,
        attempt,
        error: String(error),
      });
      throw error;
    }

    // Don't retry on 4xx errors (client errors)
    if (error instanceof Error && error.message.includes('HTTP 4')) {
      throw error;
    }

    // Exponential backoff
    const delay = INITIAL_RETRY_DELAY * Math.pow(2, attempt - 1);
    safeLog.warn('[Limitless] Retry attempt', {
      url,
      attempt,
      nextDelay: delay,
      error: String(error),
    });

    await sleep(delay);
    return fetchWithRetry(url, options, attempt + 1);
  }
}

/**
 * Sleep utility
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
