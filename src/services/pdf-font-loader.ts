import type { Env } from '../types';
import { safeLog } from '../utils/log-sanitizer';

let cachedKey: string | null = null;
let cachedBytes: Uint8Array | null = null;
let cachedErrorKey: string | null = null;

/**
 * Load a CJK-capable font from R2 for HTML-receipt PDF generation.
 *
 * Why: pdf-lib standard fonts cannot encode Japanese, leading to "???".
 *
 * Configure:
 * - Set `PDF_CJK_FONT_R2_KEY` to an object key in the receipts bucket, e.g.
 *   `fonts/NotoSansJP-Regular.ttf`
 */
export async function loadCjkFontBytes(env: Env): Promise<Uint8Array | null> {
  const key = (env.PDF_CJK_FONT_R2_KEY || '').trim();
  if (!key) return null;

  if (cachedBytes && cachedKey === key) {
    return cachedBytes;
  }

  // If we already failed for this key in this isolate, don't spam R2.
  if (cachedErrorKey === key) {
    return null;
  }

  const bucket = env.RECEIPTS ?? env.R2;
  if (!bucket) {
    safeLog.warn('[PDF Font] R2 bucket not configured (cannot load CJK font)', { key });
    cachedErrorKey = key;
    return null;
  }

  try {
    const obj = await bucket.get(key);
    if (!obj) {
      safeLog.warn('[PDF Font] Font object not found in R2', { key });
      cachedErrorKey = key;
      return null;
    }
    const ab = await obj.arrayBuffer();
    cachedBytes = new Uint8Array(ab);
    cachedKey = key;
    cachedErrorKey = null;
    safeLog.info('[PDF Font] Loaded CJK font from R2', { key, bytes: cachedBytes.byteLength });
    return cachedBytes;
  } catch (error) {
    safeLog.warn('[PDF Font] Failed to load CJK font from R2', { key, error: String(error) });
    cachedErrorKey = key;
    return null;
  }
}
