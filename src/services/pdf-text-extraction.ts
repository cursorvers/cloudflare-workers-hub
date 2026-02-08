import type { Env } from '../types';
import { safeLog } from '../utils/log-sanitizer';

export interface MaybeExtractedPdfText {
  attempted: boolean;
  extracted: boolean;
  text?: string;
  totalPages?: number;
  elapsedMs?: number;
  reason?: string;
}

function parseBool(value: string | undefined): boolean {
  return value === 'true' || value === '1' || value === 'yes';
}

function parseNumber(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function shouldSample(sampleRate: number): boolean {
  if (sampleRate <= 0) return false;
  if (sampleRate >= 1) return true;
  const rand = crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;
  return rand < sampleRate;
}

function getByteLength(input: ArrayBuffer | ArrayBufferView): number {
  if (input instanceof ArrayBuffer) return input.byteLength;
  return input.byteLength;
}

function looksLikePdf(input: ArrayBuffer | ArrayBufferView): boolean {
  // PDF header is "%PDF-" near the beginning. Allow some leading bytes.
  const bytes = input instanceof ArrayBuffer
    ? new Uint8Array(input, 0, Math.min(input.byteLength, 1024))
    : new Uint8Array(input.buffer, input.byteOffset, Math.min(input.byteLength, 1024));

  const magic = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"
  outer: for (let i = 0; i + magic.length <= bytes.length; i++) {
    for (let j = 0; j < magic.length; j++) {
      if (bytes[i + j] !== magic[j]) continue outer;
    }
    return true;
  }
  return false;
}

export async function maybeExtractPdfTextForClassification(
  env: Env,
  pdfBytes: ArrayBuffer | ArrayBufferView,
  context: Record<string, unknown>
): Promise<MaybeExtractedPdfText> {
  const enabled = parseBool(env.PDF_TEXT_EXTRACTION_ENABLED);
  const sampleRate = parseNumber(env.PDF_TEXT_EXTRACTION_SAMPLE_RATE, 0);
  if (!enabled || !shouldSample(sampleRate)) {
    return { attempted: false, extracted: false, reason: enabled ? 'sampled_out' : 'disabled' };
  }

  try {
    const maxBytes = parseNumber(env.PDF_TEXT_EXTRACTION_MAX_BYTES, 10 * 1024 * 1024);
    const maxPages = parseNumber(env.PDF_TEXT_EXTRACTION_MAX_PAGES, 50);
    const maxChars = Math.max(0, parseNumber(env.PDF_TEXT_EXTRACTION_MAX_CHARS, 8000));

    const byteLength = getByteLength(pdfBytes);
    if (byteLength === 0) {
      safeLog.info('[PDF Text Extraction] Skipped (empty)', { ...context });
      return { attempted: false, extracted: false, reason: 'empty' };
    }
    if (byteLength > maxBytes) {
      safeLog.info('[PDF Text Extraction] Skipped (too large)', { ...context, byteLength, maxBytes });
      return { attempted: false, extracted: false, reason: 'too_large' };
    }
    if (!looksLikePdf(pdfBytes)) {
      safeLog.info('[PDF Text Extraction] Skipped (not a PDF)', { ...context, byteLength });
      return { attempted: false, extracted: false, reason: 'not_pdf' };
    }

    const start = Date.now();

    // Dynamic import keeps the heavy dependency out of the hot path when disabled.
    const { extractPdfText } = await import('./pdf-text-extractor');
    const res = await extractPdfText(pdfBytes, { maxBytes, maxPages });

    const elapsedMs = Date.now() - start;
    const text = maxChars > 0 ? res.text.slice(0, maxChars) : '';

    safeLog.info('[PDF Text Extraction] Extracted PDF text', {
      ...context,
      elapsedMs,
      byteLength: res.byteLength,
      totalPages: res.totalPages,
      textLength: res.text.length,
      truncatedTo: maxChars,
    });

    return {
      attempted: true,
      extracted: true,
      text,
      totalPages: res.totalPages,
      elapsedMs,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    safeLog.warn('[PDF Text Extraction] Failed to extract PDF text (continuing without it)', {
      ...context,
      error: message,
    });
    return { attempted: true, extracted: false, reason: 'error' };
  }
}
