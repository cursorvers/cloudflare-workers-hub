import { describe, it, expect } from 'vitest';
import { convertHtmlReceiptToPdf } from './html-to-pdf-converter';

describe('html-to-pdf-converter', () => {
  it('generates a valid PDF from text content', async () => {
    const pdf = await convertHtmlReceiptToPdf('Order total: $50.00\nThank you');

    expect(pdf).toBeInstanceOf(Uint8Array);
    expect(pdf.byteLength).toBeGreaterThan(0);
    // PDF magic bytes: %PDF
    const header = new TextDecoder().decode(pdf.slice(0, 5));
    expect(header).toBe('%PDF-');
  });

  it('includes header metadata when provided', async () => {
    const pdf = await convertHtmlReceiptToPdf('Item: Widget\nPrice: 1000 JPY', {
      subject: 'Your receipt from Stripe',
      from: 'receipts@stripe.com',
      date: '2026-02-10T00:00:00Z',
      receiptId: 'abc123',
    });

    expect(pdf).toBeInstanceOf(Uint8Array);
    expect(pdf.byteLength).toBeGreaterThan(100);
  });

  it('handles empty content with a single page', async () => {
    const pdf = await convertHtmlReceiptToPdf('');

    expect(pdf).toBeInstanceOf(Uint8Array);
    const header = new TextDecoder().decode(pdf.slice(0, 5));
    expect(header).toBe('%PDF-');
  });

  it('handles very long content across multiple pages', async () => {
    const longText = Array.from({ length: 200 }, (_, i) => `Line ${i + 1}: This is a receipt line item with some description`).join('\n');
    const pdf = await convertHtmlReceiptToPdf(longText);

    expect(pdf).toBeInstanceOf(Uint8Array);
    expect(pdf.byteLength).toBeGreaterThan(1000);
  });

  it('handles non-Latin characters by replacing with placeholder', async () => {
    const japaneseText = '領収書: ¥5,000\n消耗品費\nAmazon.co.jp';
    const pdf = await convertHtmlReceiptToPdf(japaneseText);

    expect(pdf).toBeInstanceOf(Uint8Array);
    // Should not throw even with CJK characters
    const header = new TextDecoder().decode(pdf.slice(0, 5));
    expect(header).toBe('%PDF-');
  });

  it('produces a PDF under 10MB for typical receipts', async () => {
    const typicalReceipt = [
      'Your receipt from Stripe',
      '',
      'Invoice #INV-2026-0042',
      'Date: February 10, 2026',
      '',
      'Description: Claude Pro subscription',
      'Amount: $20.00',
      'Tax: $0.00',
      'Total: $20.00',
      '',
      'Payment method: Visa ending in 4242',
      'Thank you for your business.',
    ].join('\n');

    const pdf = await convertHtmlReceiptToPdf(typicalReceipt, {
      subject: 'Your receipt from Stripe',
      from: 'receipts@stripe.com',
      date: '2026-02-10T00:00:00Z',
    });

    // Typical receipt PDF should be well under 10MB (freee limit)
    expect(pdf.byteLength).toBeLessThan(10 * 1024 * 1024);
    // But should be a reasonable size (at least 1KB)
    expect(pdf.byteLength).toBeGreaterThan(1024);
  });
});
