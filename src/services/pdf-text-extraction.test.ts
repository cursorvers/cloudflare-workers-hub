import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the dynamic import target
vi.mock('./pdf-text-extractor', () => ({
  extractPdfText: vi.fn().mockResolvedValue({
    text: 'Hello World PDF Content - Amount: ¥5,000',
    totalPages: 2,
    byteLength: 1024,
  }),
}));

// Mock safeLog
vi.mock('../utils/log-sanitizer', () => ({
  safeLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function createFakePdfBuffer(size = 1024): ArrayBuffer {
  const buf = new ArrayBuffer(size);
  const view = new Uint8Array(buf);
  const header = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"
  for (let i = 0; i < header.length; i++) view[i] = header[i];
  return buf;
}

function createNonPdfBuffer(size = 512): ArrayBuffer {
  const buf = new ArrayBuffer(size);
  const view = new Uint8Array(buf);
  const header = [0x89, 0x50, 0x4e, 0x47]; // PNG
  for (let i = 0; i < header.length; i++) view[i] = header[i];
  return buf;
}

function makeEnv(overrides: Record<string, string> = {}): any {
  return {
    PDF_TEXT_EXTRACTION_ENABLED: 'true',
    PDF_TEXT_EXTRACTION_SAMPLE_RATE: '1',
    PDF_TEXT_EXTRACTION_MAX_BYTES: String(10 * 1024 * 1024),
    PDF_TEXT_EXTRACTION_MAX_PAGES: '50',
    PDF_TEXT_EXTRACTION_MAX_CHARS: '8000',
    ...overrides,
  };
}

describe('maybeExtractPdfTextForClassification', () => {
  let maybeExtractPdfTextForClassification: typeof import('./pdf-text-extraction')['maybeExtractPdfTextForClassification'];
  let extractPdfTextMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    const extractor = await import('./pdf-text-extractor');
    extractPdfTextMock = extractor.extractPdfText as ReturnType<typeof vi.fn>;
    extractPdfTextMock.mockResolvedValue({
      text: 'Hello World PDF Content - Amount: ¥5,000',
      totalPages: 2,
      byteLength: 1024,
    });
    const mod = await import('./pdf-text-extraction');
    maybeExtractPdfTextForClassification = mod.maybeExtractPdfTextForClassification;
  });

  // Feature flags
  it('returns disabled when extraction is off', async () => {
    const env = makeEnv({ PDF_TEXT_EXTRACTION_ENABLED: 'false' });
    const result = await maybeExtractPdfTextForClassification(env, createFakePdfBuffer(), {});
    expect(result.attempted).toBe(false);
    expect(result.reason).toBe('disabled');
  });

  it('returns sampled_out when sample rate is 0', async () => {
    const env = makeEnv({ PDF_TEXT_EXTRACTION_SAMPLE_RATE: '0' });
    const result = await maybeExtractPdfTextForClassification(env, createFakePdfBuffer(), {});
    expect(result.attempted).toBe(false);
    expect(result.reason).toBe('sampled_out');
  });

  it('always processes when sample rate is 1', async () => {
    const result = await maybeExtractPdfTextForClassification(makeEnv(), createFakePdfBuffer(), {});
    expect(result.attempted).toBe(true);
    expect(result.extracted).toBe(true);
  });

  // Pre-parsing guards
  it('skips empty buffer', async () => {
    const result = await maybeExtractPdfTextForClassification(makeEnv(), new ArrayBuffer(0), {});
    expect(result.attempted).toBe(false);
    expect(result.reason).toBe('empty');
  });

  it('skips buffer exceeding maxBytes', async () => {
    const env = makeEnv({ PDF_TEXT_EXTRACTION_MAX_BYTES: '100' });
    const result = await maybeExtractPdfTextForClassification(env, createFakePdfBuffer(200), {});
    expect(result.attempted).toBe(false);
    expect(result.reason).toBe('too_large');
  });

  it('skips non-PDF files', async () => {
    const result = await maybeExtractPdfTextForClassification(makeEnv(), createNonPdfBuffer(), {});
    expect(result.attempted).toBe(false);
    expect(result.reason).toBe('not_pdf');
  });

  // Successful extraction
  it('returns extracted text with metadata', async () => {
    const result = await maybeExtractPdfTextForClassification(makeEnv(), createFakePdfBuffer(), {});
    expect(result.extracted).toBe(true);
    expect(result.text).toContain('Hello World');
    expect(result.totalPages).toBe(2);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('truncates text to maxChars', async () => {
    extractPdfTextMock.mockResolvedValue({ text: 'A'.repeat(10000), totalPages: 1, byteLength: 512 });
    const env = makeEnv({ PDF_TEXT_EXTRACTION_MAX_CHARS: '100' });
    const result = await maybeExtractPdfTextForClassification(env, createFakePdfBuffer(), {});
    expect(result.text!.length).toBeLessThanOrEqual(100);
  });

  it('returns empty string when maxChars is 0', async () => {
    const env = makeEnv({ PDF_TEXT_EXTRACTION_MAX_CHARS: '0' });
    const result = await maybeExtractPdfTextForClassification(env, createFakePdfBuffer(), {});
    expect(result.extracted).toBe(true);
    expect(result.text).toBe('');
  });

  // Error handling
  it('returns error result when extractor throws', async () => {
    extractPdfTextMock.mockRejectedValue(new Error('corrupt PDF'));
    const result = await maybeExtractPdfTextForClassification(makeEnv(), createFakePdfBuffer(), {});
    expect(result.attempted).toBe(true);
    expect(result.extracted).toBe(false);
    expect(result.reason).toBe('error');
  });

  // ArrayBufferView
  it('accepts Uint8Array input', async () => {
    const uint8 = new Uint8Array(createFakePdfBuffer());
    const result = await maybeExtractPdfTextForClassification(makeEnv(), uint8, {});
    expect(result.extracted).toBe(true);
  });
});
