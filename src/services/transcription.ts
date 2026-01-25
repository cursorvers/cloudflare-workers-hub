/**
 * Whisper Transcription Service
 *
 * Provides audio transcription using Cloudflare Workers AI (@cf/openai/whisper-large-v3-turbo)
 * Features:
 * - Supports ArrayBuffer and Base64 inputs
 * - Automatic retry logic with exponential backoff
 * - Chunking support for large files (>25MB)
 * - WebVTT subtitle generation
 */

import { z } from 'zod';
import { Env } from '../types';
import { safeLog } from '../utils/log-sanitizer';

// Zod schema for transcription options
const TranscriptionOptionsSchema = z.object({
  language: z.string().optional(), // ISO 639-1 language code (e.g., 'en', 'ja')
});

export type TranscriptionOptions = z.infer<typeof TranscriptionOptionsSchema>;

// Result interface
export interface TranscriptionResult {
  text: string;
  language: string;
  confidence: number;
  duration_seconds?: number;
  vtt?: string; // WebVTT subtitles if available
}

// Internal AI response interface
interface WhisperAIResponse {
  text: string;
  word_count?: number;
  words?: Array<{
    word: string;
    start: number;
    end: number;
  }>;
}

// Constants
const WHISPER_MODEL = '@cf/openai/whisper-large-v3-turbo';
const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB
const CHUNK_SIZE = 20 * 1024 * 1024; // 20MB per chunk
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY = 1000; // 1 second

/**
 * Transcribe audio using Whisper model
 *
 * @param env - Cloudflare Workers environment
 * @param audio - Audio data as ArrayBuffer or Base64 string
 * @param options - Optional configuration (language hint)
 * @returns Transcription result with text, language, and confidence
 */
export async function transcribeAudio(
  env: Env,
  audio: ArrayBuffer | string,
  options?: TranscriptionOptions
): Promise<TranscriptionResult> {
  // Validate options
  const validatedOptions = options ? TranscriptionOptionsSchema.parse(options) : {};

  // Convert input to ArrayBuffer if needed
  const audioBuffer = typeof audio === 'string' ? base64ToArrayBuffer(audio) : audio;

  // Check file size
  if (audioBuffer.byteLength > MAX_FILE_SIZE) {
    safeLog.info('[Transcription] Large file detected, using chunking', {
      size: audioBuffer.byteLength,
      chunks: Math.ceil(audioBuffer.byteLength / CHUNK_SIZE),
    });
    return transcribeWithChunking(env, audioBuffer, validatedOptions);
  }

  // Standard transcription for files under 25MB
  return transcribeWithRetry(env, audioBuffer, validatedOptions);
}

/**
 * Transcribe with automatic retry on failure
 */
async function transcribeWithRetry(
  env: Env,
  audioBuffer: ArrayBuffer,
  options: TranscriptionOptions,
  attempt = 1
): Promise<TranscriptionResult> {
  try {
    return await performTranscription(env, audioBuffer, options);
  } catch (error) {
    if (attempt >= MAX_RETRIES) {
      safeLog.error('[Transcription] Max retries exceeded', {
        attempt,
        error: String(error),
      });
      throw new Error(`Transcription failed after ${MAX_RETRIES} attempts: ${String(error)}`);
    }

    // Exponential backoff
    const delay = INITIAL_RETRY_DELAY * Math.pow(2, attempt - 1);
    safeLog.warn('[Transcription] Retry attempt', {
      attempt,
      nextDelay: delay,
      error: String(error),
    });

    await sleep(delay);
    return transcribeWithRetry(env, audioBuffer, options, attempt + 1);
  }
}

/**
 * Core transcription logic
 */
async function performTranscription(
  env: Env,
  audioBuffer: ArrayBuffer,
  options: TranscriptionOptions
): Promise<TranscriptionResult> {
  try {
    // Prepare input for Workers AI
    const input: {
      audio: number[];
      source_lang?: string;
    } = {
      audio: Array.from(new Uint8Array(audioBuffer)),
    };

    if (options.language) {
      input.source_lang = options.language;
    }

    safeLog.info('[Transcription] Sending to Workers AI', {
      model: WHISPER_MODEL,
      audioSize: audioBuffer.byteLength,
      language: options.language,
    });

    // Call Workers AI with type assertion for newer models
    const response = (await (env.AI.run as (model: string, input: unknown) => Promise<unknown>)(
      WHISPER_MODEL,
      input
    )) as WhisperAIResponse;

    // Extract transcription result
    const result: TranscriptionResult = {
      text: response.text || '',
      language: options.language || 'unknown',
      confidence: calculateConfidence(response),
      duration_seconds: estimateDuration(audioBuffer.byteLength),
    };

    // Generate WebVTT if word timestamps are available
    if (response.words && response.words.length > 0) {
      result.vtt = generateWebVTT(response.words);
    }

    safeLog.info('[Transcription] Success', {
      textLength: result.text.length,
      wordCount: response.word_count,
      hasVTT: !!result.vtt,
    });

    return result;
  } catch (error) {
    safeLog.error('[Transcription] Workers AI error', {
      error: String(error),
      audioSize: audioBuffer.byteLength,
    });
    throw error;
  }
}

/**
 * Handle large files by splitting into chunks
 */
async function transcribeWithChunking(
  env: Env,
  audioBuffer: ArrayBuffer,
  options: TranscriptionOptions
): Promise<TranscriptionResult> {
  const chunks = splitAudioIntoChunks(audioBuffer, CHUNK_SIZE);
  const results: TranscriptionResult[] = [];

  safeLog.info('[Transcription] Processing chunks', {
    totalChunks: chunks.length,
  });

  for (let i = 0; i < chunks.length; i++) {
    safeLog.info(`[Transcription] Processing chunk ${i + 1}/${chunks.length}`);
    const result = await transcribeWithRetry(env, chunks[i], options);
    results.push(result);
  }

  // Merge results
  return mergeTranscriptionResults(results);
}

/**
 * Split audio buffer into chunks
 */
function splitAudioIntoChunks(buffer: ArrayBuffer, chunkSize: number): ArrayBuffer[] {
  const chunks: ArrayBuffer[] = [];
  let offset = 0;

  while (offset < buffer.byteLength) {
    const length = Math.min(chunkSize, buffer.byteLength - offset);
    chunks.push(buffer.slice(offset, offset + length));
    offset += length;
  }

  return chunks;
}

/**
 * Merge multiple transcription results
 */
function mergeTranscriptionResults(results: TranscriptionResult[]): TranscriptionResult {
  if (results.length === 0) {
    throw new Error('No transcription results to merge');
  }

  if (results.length === 1) {
    return results[0];
  }

  // Concatenate text with space
  const mergedText = results.map(r => r.text).join(' ');

  // Average confidence
  const avgConfidence =
    results.reduce((sum, r) => sum + r.confidence, 0) / results.length;

  // Sum durations
  const totalDuration = results.reduce((sum, r) => sum + (r.duration_seconds || 0), 0);

  // Use language from first result
  const language = results[0].language;

  // Merge VTT if available
  const vtt = results.every(r => r.vtt)
    ? results.map(r => r.vtt).join('\n\n')
    : undefined;

  return {
    text: mergedText,
    language,
    confidence: avgConfidence,
    duration_seconds: totalDuration,
    vtt,
  };
}

/**
 * Convert Base64 string to ArrayBuffer
 */
function base64ToArrayBuffer(base64: string): ArrayBuffer {
  // Remove data URL prefix if present
  const base64Data = base64.replace(/^data:audio\/[^;]+;base64,/, '');

  try {
    const binaryString = atob(base64Data);
    const bytes = new Uint8Array(binaryString.length);

    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    return bytes.buffer;
  } catch (error) {
    throw new Error(`Invalid Base64 audio data: ${String(error)}`);
  }
}

/**
 * Calculate confidence score from AI response
 * Uses word count as a proxy if no explicit confidence is provided
 */
function calculateConfidence(response: WhisperAIResponse): number {
  // If word count is available, use it as a proxy
  // More words generally indicate higher confidence
  if (response.word_count && response.word_count > 0) {
    // Normalize to 0-1 range (assuming >50 words is high confidence)
    return Math.min(response.word_count / 50, 1.0);
  }

  // Default confidence if no metrics available
  return response.text && response.text.length > 0 ? 0.8 : 0.0;
}

/**
 * Estimate audio duration from file size
 * Rough estimate: 1MB ≈ 60 seconds for typical compressed audio
 */
function estimateDuration(byteLength: number): number {
  const megabytes = byteLength / (1024 * 1024);
  return megabytes * 60; // 60 seconds per MB
}

/**
 * Generate WebVTT subtitle format from word timestamps
 */
function generateWebVTT(words: Array<{ word: string; start: number; end: number }>): string {
  let vtt = 'WEBVTT\n\n';

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const startTime = formatVTTTimestamp(word.start);
    const endTime = formatVTTTimestamp(word.end);

    vtt += `${i + 1}\n`;
    vtt += `${startTime} --> ${endTime}\n`;
    vtt += `${word.word}\n\n`;
  }

  return vtt;
}

/**
 * Format timestamp for WebVTT (HH:MM:SS.mmm)
 */
function formatVTTTimestamp(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const milliseconds = Math.floor((seconds % 1) * 1000);

  return `${padZero(hours)}:${padZero(minutes)}:${padZero(secs)}.${padZero(milliseconds, 3)}`;
}

/**
 * Pad number with leading zeros
 */
function padZero(num: number, length = 2): string {
  return num.toString().padStart(length, '0');
}

/**
 * Sleep utility for retry delays
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
