import { describe, it, expect } from 'vitest';
import { extractPdfText } from './pdf-text-extractor';
import { createMinimalHelloWorldPdf } from '../poc/pdf-fixtures';

describe('pdf-text-extractor', () => {
  it('extracts text from a minimal PDF', async () => {
    const pdfBuffer = createMinimalHelloWorldPdf();
    const result = await extractPdfText(pdfBuffer);

    expect(result.totalPages).toBe(1);
    expect(result.text).toContain('Hello World');
    expect(result.byteLength).toBeGreaterThan(0);
  });

  it('rejects empty ArrayBuffer', async () => {
    const emptyBuffer = new ArrayBuffer(0);
    await expect(extractPdfText(emptyBuffer)).rejects.toThrow();
  });

  it('accepts Uint8Array views without leaking unrelated bytes', async () => {
    const full = new Uint8Array(createMinimalHelloWorldPdf());
    const view = full.subarray(0, full.length); // view backed by same buffer
    const expectedLen = view.byteLength;
    const result = await extractPdfText(view);
    expect(result.byteLength).toBe(expectedLen);
    expect(view.byteLength).toBe(expectedLen);
    expect(result.text).toContain('Hello World');
  });
});
