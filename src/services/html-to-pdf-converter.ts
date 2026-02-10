/**
 * HTML to PDF Converter
 *
 * Converts HTML receipt text content to a PDF file using pdf-lib.
 * Designed for Cloudflare Workers (pure JS, no native deps).
 *
 * The PDF is a text-based document (not a visual HTML render),
 * sufficient for freee File Box which accepts PDF uploads.
 */

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

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
}

// ── Main conversion function ─────────────────────────────────────────

export async function convertHtmlReceiptToPdf(
  textContent: string,
  options: HtmlToPdfOptions = {}
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const boldFont = await doc.embedFont(StandardFonts.HelveticaBold);

  // Build header lines
  const headerLines: string[] = [];
  if (options.subject) {
    headerLines.push(`Subject: ${options.subject}`);
  }
  if (options.from) {
    headerLines.push(`From: ${options.from}`);
  }
  if (options.date) {
    headerLines.push(`Date: ${options.date}`);
  }
  if (headerLines.length > 0) {
    headerLines.push(''); // blank separator
  }

  // Wrap text into lines that fit within page width
  const bodyLines = wrapText(textContent, font, FONT_SIZE, MAX_LINE_WIDTH);
  const allLines = [...headerLines, ...bodyLines];

  // Paginate
  const usableHeight = PAGE_HEIGHT - MARGIN_TOP - MARGIN_BOTTOM;
  const linesPerPage = Math.floor(usableHeight / LINE_HEIGHT);

  for (let offset = 0; offset < allLines.length; offset += linesPerPage) {
    const pageLines = allLines.slice(offset, offset + linesPerPage);
    const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);

    let y = PAGE_HEIGHT - MARGIN_TOP;

    for (let i = 0; i < pageLines.length; i++) {
      const line = pageLines[i];
      const lineIndex = offset + i;
      const isHeader = lineIndex < headerLines.length && line.length > 0;

      page.drawText(sanitizeForPdf(line), {
        x: MARGIN_LEFT,
        y,
        size: isHeader ? HEADER_FONT_SIZE : FONT_SIZE,
        font: isHeader ? boldFont : font,
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

    page.drawText(footer, {
      x: MARGIN_LEFT,
      y: MARGIN_BOTTOM - 20,
      size: 8,
      font,
      color: rgb(0.5, 0.5, 0.5),
    });
  }

  // If no content at all, add one blank page with a note
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
  maxWidth: number
): string[] {
  const result: string[] = [];
  const paragraphs = text.split('\n');

  for (const paragraph of paragraphs) {
    if (paragraph.trim().length === 0) {
      result.push('');
      continue;
    }

    const words = paragraph.split(/\s+/);
    let currentLine = '';

    for (const word of words) {
      const testLine = currentLine.length > 0 ? `${currentLine} ${word}` : word;
      const width = measureWidth(font, testLine, fontSize);

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

function measureWidth(font: FontLike, text: string, fontSize: number): number {
  try {
    return font.widthOfTextAtSize(sanitizeForPdf(text), fontSize);
  } catch {
    // Fallback: estimate width for characters pdf-lib can't measure
    return text.length * fontSize * 0.5;
  }
}

/**
 * Remove characters that pdf-lib's standard fonts cannot encode.
 * Standard PDF fonts (Helvetica etc.) only support WinAnsi (Latin-1).
 * CJK and other non-Latin characters are replaced with a placeholder
 * to prevent encoding errors while keeping the document readable.
 */
function sanitizeForPdf(text: string): string {
  // Replace characters outside WinAnsi range with '?'
  // WinAnsi covers: ASCII 0x20-0x7E + Latin-1 Supplement 0xA0-0xFF
  return text.replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');
}
