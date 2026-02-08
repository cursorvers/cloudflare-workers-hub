/**
 * PDF Text Extractor - Workers-compatible PDF text extraction using unpdf
 *
 * Step 0 PoC: Verify unpdf works in Cloudflare Workers environment
 */
import { extractText, getDocumentProxy } from 'unpdf';

export interface PdfExtractionResult {
  text: string;
  totalPages: number;
  byteLength: number;
}

export type PdfExtractionInput = ArrayBuffer | ArrayBufferView;

export interface PdfExtractionOptions {
  /**
   * Hard cap to avoid CPU/memory blowups on malformed/huge PDFs.
   * (Workers upload limit is already 10MB, but this can be smaller for safety.)
   */
  maxBytes?: number;
  /**
   * Optional page cap after parsing.
   */
  maxPages?: number;
}

function toUint8Array(input: PdfExtractionInput): { bytes: Uint8Array; byteLength: number } {
  if (input instanceof ArrayBuffer) {
    const bytes = new Uint8Array(input);
    return { bytes, byteLength: bytes.byteLength };
  }
  const view = input as ArrayBufferView;
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  return { bytes, byteLength: view.byteLength };
}

/**
 * Extract text from a PDF buffer.
 * Returns extracted text, page count, and original byte length.
 */
export async function extractPdfText(
  pdfBuffer: PdfExtractionInput,
  options: PdfExtractionOptions = {},
): Promise<PdfExtractionResult> {
  const { bytes, byteLength } = toUint8Array(pdfBuffer);
  if (byteLength === 0) {
    throw new Error('Empty PDF buffer');
  }
  if (options.maxBytes !== undefined && byteLength > options.maxBytes) {
    throw new Error(`PDF too large: ${byteLength} bytes (max ${options.maxBytes})`);
  }

  // Some parsers/transports may detach (transfer) the underlying ArrayBuffer.
  // Copy to avoid mutating caller-owned buffers/views.
  const pdf = await getDocumentProxy(bytes.slice());
  const { totalPages, text } = await extractText(pdf, { mergePages: true });
  if (options.maxPages !== undefined && totalPages > options.maxPages) {
    throw new Error(`PDF has too many pages: ${totalPages} (max ${options.maxPages})`);
  }

  return {
    text: typeof text === 'string' ? text : (text as string[]).join('\n'),
    totalPages,
    byteLength,
  };
}
