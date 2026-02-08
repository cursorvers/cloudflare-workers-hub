import { describe, it, expect } from 'vitest';
import { buildClassificationText } from './receipt-gmail-poller';

describe('buildClassificationText', () => {
  const baseEmail = {
    subject: 'Receipt for order #12345',
    from: 'noreply@amazon.co.jp',
    date: new Date('2026-02-08T10:00:00Z'),
  } as any;

  const baseAttachment = {
    filename: 'receipt.pdf',
    mimeType: 'application/pdf',
    attachmentId: 'att-001',
    size: 1024,
  } as any;

  it('builds text with email metadata only (no PDF text)', () => {
    const result = buildClassificationText(baseEmail, baseAttachment);
    expect(result).toContain('Subject: Receipt for order #12345');
    expect(result).toContain('From: noreply@amazon.co.jp');
    expect(result).toContain('Attachment: receipt.pdf');
    expect(result).not.toContain('---BEGIN PDF TEXT---');
  });

  it('includes PDF text when provided', () => {
    const pdfText = '¥5,000 消耗品費 Amazon.co.jp 領収書';
    const result = buildClassificationText(baseEmail, baseAttachment, pdfText);
    expect(result).toContain('---BEGIN PDF TEXT---');
    expect(result).toContain(pdfText);
    expect(result).toContain('---END PDF TEXT---');
  });

  it('excludes PDF markers when extractedPdfText is empty string', () => {
    const result = buildClassificationText(baseEmail, baseAttachment, '');
    expect(result).not.toContain('---BEGIN PDF TEXT---');
  });

  it('excludes PDF markers when extractedPdfText is whitespace only', () => {
    const result = buildClassificationText(baseEmail, baseAttachment, '   \n\t  ');
    expect(result).not.toContain('---BEGIN PDF TEXT---');
  });

  it('excludes PDF markers when extractedPdfText is undefined', () => {
    const result = buildClassificationText(baseEmail, baseAttachment, undefined);
    expect(result).not.toContain('---BEGIN PDF TEXT---');
  });
});
