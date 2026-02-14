/**
 * HTML to PDF Converter
 *
 * Converts HTML receipt text content to a PDF file using pdf-lib.
 * Designed for Cloudflare Workers (pure JS, no headless browser).
 *
 * The PDF is text-based (not a visual HTML render). This is sufficient as
 * an evidence attachment for freee File Box when the original receipt is an
 * HTML email body.
 */

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

// ── Configuration ────────────────────────────────────────────────────

const PAGE_WIDTH = 595.28; // A4 in points
const PAGE_HEIGHT = 841.89;
const MARGIN_TOP = 50;
const MARGIN_BOTTOM = 50;
const MARGIN_LEFT = 50;
const MARGIN_RIGHT = 50;
const LINE_HEIGHT = 14;
const FONT_SIZE = 10;
const HEADER_FONT_SIZE = 12;
const MAX_LINE_WIDTH = PAGE_WIDTH - MARGIN_LEFT - MARGIN_RIGHT;

export interface HtmlToPdfOptions {
  readonly subject?: string;
  readonly from?: string;
  readonly date?: string;
  readonly receiptId?: string;
  /**
   * Optional font bytes for CJK (Japanese) support.
   * If provided, text is NOT sanitized and the font is embedded (subset).
   */
  readonly fontBytes?: Uint8Array | null;
}

// ── Main conversion function ─────────────────────────────────────────

export async function convertHtmlReceiptToPdf(
  textContent: string,
  options: HtmlToPdfOptions = {}
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();

  const useCustomFont = options.fontBytes && options.fontBytes.byteLength > 0;
  if (useCustomFont) {
    // Enables embedding and subsetting for custom fonts.
    doc.registerFontkit(fontkit);
  }

  const font = useCustomFont
    ? await doc.embedFont(options.fontBytes!, { subset: true })
    : await doc.embedFont(StandardFonts.Helvetica);

  // We don't have a bold variant for arbitrary custom fonts; keep header readable via size.
  const headerFont = useCustomFont
    ? font
    : await doc.embedFont(StandardFonts.HelveticaBold);

  // Build header lines
  const headerLines: string[] = [];
  if (options.subject) headerLines.push(`Subject: ${options.subject}`);
  if (options.from) headerLines.push(`From: ${options.from}`);
  if (options.date) headerLines.push(`Date: ${options.date}`);
  if (headerLines.length > 0) headerLines.push('');

  const sanitize = !useCustomFont;
  const bodyLines = wrapText(textContent, font, FONT_SIZE, MAX_LINE_WIDTH, sanitize);
  const allLines = [...headerLines, ...bodyLines];

  // Paginate
  const usableHeight = PAGE_HEIGHT - MARGIN_TOP - MARGIN_BOTTOM;
  const linesPerPage = Math.max(1, Math.floor(usableHeight / LINE_HEIGHT));

  for (let offset = 0; offset < allLines.length; offset += linesPerPage) {
    const pageLines = allLines.slice(offset, offset + linesPerPage);
    const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);

    let y = PAGE_HEIGHT - MARGIN_TOP;

    for (let i = 0; i < pageLines.length; i++) {
      const line = pageLines[i];
      const lineIndex = offset + i;
      const isHeader = lineIndex < headerLines.length && line.length > 0;

      page.drawText(sanitizeForPdf(line, sanitize), {
        x: MARGIN_LEFT,
        y,
        size: isHeader ? HEADER_FONT_SIZE : FONT_SIZE,
        font: isHeader ? headerFont : font,
        color: rgb(0, 0, 0),
        maxWidth: MAX_LINE_WIDTH,
      });

      y -= LINE_HEIGHT;
    }

    // Footer: receipt ID + page number
    const pageNum = Math.floor(offset / linesPerPage) + 1;
    const totalPages = Math.ceil(allLines.length / linesPerPage);
    const footer = options.receiptId
      ? `Receipt: ${options.receiptId} | Page ${pageNum}/${totalPages}`
      : `Page ${pageNum}/${totalPages}`;

    page.drawText(sanitizeForPdf(footer, true), {
      x: MARGIN_LEFT,
      y: MARGIN_BOTTOM - 20,
      size: 8,
      font: useCustomFont ? font : (font as any),
      color: rgb(0.5, 0.5, 0.5),
    });
  }

  if (allLines.length === 0) {
    const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    page.drawText('(Empty receipt)', {
      x: MARGIN_LEFT,
      y: PAGE_HEIGHT - MARGIN_TOP,
      size: FONT_SIZE,
      font,
      color: rgb(0.5, 0.5, 0.5),
    });
  }

  return doc.save();
}

// ── Text wrapping ────────────────────────────────────────────────────

interface FontLike {
  widthOfTextAtSize(text: string, size: number): number;
}

function wrapText(
  text: string,
  font: FontLike,
  fontSize: number,
  maxWidth: number,
  sanitize: boolean
): string[] {
  const result: string[] = [];
  const paragraphs = text.split('\n');

  for (const paragraph of paragraphs) {
    if (paragraph.trim().length === 0) {
      result.push('');
      continue;
    }

    const hasWhitespace = /\s/.test(paragraph);
    if (!hasWhitespace) {
      // CJK/long tokens: break by character.
      let line = '';
      for (const ch of Array.from(paragraph)) {
        const testLine = line + ch;
        if (measureWidth(font, testLine, fontSize, sanitize) > maxWidth && line.length > 0) {
          result.push(line);
          line = ch;
        } else {
          line = testLine;
        }
      }
      if (line.length > 0) result.push(line);
      continue;
    }

    const words = paragraph.split(/\s+/);
    let currentLine = '';

    for (const word of words) {
      const testLine = currentLine.length > 0 ? `${currentLine} ${word}` : word;
      const width = measureWidth(font, testLine, fontSize, sanitize);

      if (width > maxWidth && currentLine.length > 0) {
        result.push(currentLine);
        currentLine = word;
      } else {
        currentLine = testLine;
      }
    }

    if (currentLine.length > 0) {
      result.push(currentLine);
    }
  }

  return result;
}

function measureWidth(font: FontLike, text: string, fontSize: number, sanitize: boolean): number {
  try {
    return font.widthOfTextAtSize(sanitizeForPdf(text, sanitize), fontSize);
  } catch {
    // Fallback: conservative estimate
    return text.length * fontSize * 0.6;
  }
}

/**
 * Standard PDF fonts (Helvetica etc.) only support WinAnsi (Latin-1).
 * When a custom font is NOT provided, replace non-WinAnsi chars with '?'
 * so pdf-lib won't throw encoding errors.
 */
function sanitizeForPdf(text: string, sanitize: boolean): string {
  if (!sanitize) return text;
  return text.replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');
}
