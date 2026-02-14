import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../services/ai-receipt-classifier', () => ({
  classifyReceipt: vi.fn(),
}));

vi.mock('../services/freee-deal-service', () => ({
  createDealFromReceipt: vi.fn(),
}));

vi.mock('../services/workflow-state-machine', () => ({
  createStateMachine: vi.fn(() => ({
    transition: vi.fn().mockResolvedValue(undefined),
    complete: vi.fn().mockResolvedValue(undefined),
    recordError: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('../services/pdf-font-loader', () => ({
  loadCjkFontBytes: vi.fn(),
}));

vi.mock('../services/google-drive-backup', () => ({
  backupToGoogleDrive: vi.fn().mockResolvedValue({ fileId: 'drive-1' }),
}));

vi.mock('../services/html-to-pdf-converter', () => ({
  convertHtmlReceiptToPdf: vi.fn(async (_text: string, options?: any) => {
    // Simulate a corrupt/invalid CJK font causing conversion to fail.
    if (options?.fontBytes) {
      throw new Error('invalid font');
    }
    // Minimal PDF header bytes.
    return new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
  }),
}));

import { classifyReceipt } from '../services/ai-receipt-classifier';
import { createDealFromReceipt } from '../services/freee-deal-service';
import { loadCjkFontBytes } from '../services/pdf-font-loader';
import { convertHtmlReceiptToPdf } from '../services/html-to-pdf-converter';

import { processHtmlReceipt } from './receipt-html-processor';

function createMockDb() {
  const statements: Array<{ sql: string; binds: unknown[] }> = [];
  const prepare = vi.fn((sql: string) => {
    const stmt = {
      bind: vi.fn((...args: unknown[]) => {
        statements.push({ sql, binds: args });
        return stmt;
      }),
      first: vi.fn(async () => null),
      run: vi.fn(async () => ({})),
    };
    return stmt;
  });
  return { prepare, statements };
}

function createMockBucket() {
  const puts: Array<{ key: string; body: Uint8Array; opts?: any }> = [];
  const objects = new Map<string, Uint8Array>();

  const bucket: R2Bucket = {
    put: vi.fn(async (key: string, value: any, opts?: any) => {
      const body = value instanceof Uint8Array
        ? value
        : value instanceof ArrayBuffer
          ? new Uint8Array(value)
          : new Uint8Array(await new Response(value).arrayBuffer());
      puts.push({ key, body, opts });
      objects.set(key, body);
      return { key } as any;
    }),
    get: vi.fn(async (key: string) => {
      const body = objects.get(key);
      if (!body) return null;
      return {
        text: async () => new TextDecoder().decode(body),
        arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
      } as any;
    }),
    head: vi.fn(async (key: string) => {
      if (!objects.has(key)) return null;
      return { key } as any;
    }),
  } as any;

  return { bucket, puts };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('receipt-html-processor', () => {
  it('stores receipt.html + receipt.txt, uploads to freee, creates deal, and retries PDF conversion without font', async () => {
    const { prepare, statements } = createMockDb();
    const { bucket, puts } = createMockBucket();

    vi.mocked(loadCjkFontBytes).mockResolvedValue(new Uint8Array([1, 2, 3]));
    vi.mocked(classifyReceipt).mockResolvedValue({
      document_type: 'receipt',
      vendor_name: 'Amazon.co.jp',
      amount: 1200,
      currency: 'JPY',
      transaction_date: '2026-02-10',
      account_category: '消耗品費',
      tax_type: undefined,
      department: undefined,
      confidence: 0.2,
      method: 'ai_assisted',
      cache_hit: false,
      amount_extracted: true,
    } as any);

    vi.mocked(createDealFromReceipt).mockResolvedValue({
      dealId: 999,
      partnerId: 77,
      mappingConfidence: 0.1,
      status: 'needs_review',
      accountItemId: 1,
      taxCode: 2,
    } as any);

    const freeeClient = {
      uploadReceipt: vi.fn(async () => ({ receipt: { id: 123 } })),
    } as any;

    const env = {
      DB: { prepare },
    } as any;

    const email = {
      messageId: 'm-1',
      threadId: 't-1',
      subject: '領収書',
      from: 'billing@example.com',
      date: new Date('2026-02-10T00:00:00Z'),
      htmlBody: {
        html: '<html><body><p>領収書: ¥1,200</p><img src="https://example.com/x.png"></body></html>',
        plainText: '領収書: ¥1,200\n消耗品費\nAmazon.co.jp',
        hasExternalReferences: true,
        externalRefTypes: ['img'],
      },
    } as any;

    const metrics = { processed: 0, skipped: 0, failed: 0, dealsCreated: 0 };
    await processHtmlReceipt(env, bucket, freeeClient, email, metrics);

    // Evidence stored in R2
    const keys = puts.map(p => p.key);
    expect(keys.some(k => k.endsWith('/receipt.html'))).toBe(true);
    expect(keys.some(k => k.endsWith('/receipt.txt'))).toBe(true);

    // Conversion attempted twice: with fontBytes (fails) then without (succeeds)
    expect(vi.mocked(convertHtmlReceiptToPdf)).toHaveBeenCalledTimes(2);
    expect((vi.mocked(convertHtmlReceiptToPdf).mock.calls[0][1] as any).fontBytes).toBeTruthy();
    expect((vi.mocked(convertHtmlReceiptToPdf).mock.calls[1][1] as any).fontBytes).toBe(null);

    // freee upload + deal creation happened
    expect(freeeClient.uploadReceipt).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createDealFromReceipt)).toHaveBeenCalledTimes(1);

    // External references should mark needs_review in D1
    const updateNeedsReview = statements.find(s =>
      s.sql.includes("SET status = 'needs_review'") && s.sql.includes('HTML_EXTERNAL_REFERENCES')
    );
    expect(updateNeedsReview).toBeTruthy();

    expect(metrics.processed).toBe(1);
    expect(metrics.failed).toBe(0);
  });
});
