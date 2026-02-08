import { describe, it, expect } from 'vitest';
import { buildClassificationText } from './receipt-gmail-poller';

describe('receipt-gmail-poller buildClassificationText', () => {
  it('does not include PDF text section when extracted text is missing/blank', () => {
    const email = {
      subject: 'Test Subject',
      from: 'sender@example.com',
      date: new Date('2026-02-07T00:00:00Z'),
    } as any;
    const attachment = { filename: 'receipt.pdf' } as any;

    const text1 = buildClassificationText(email, attachment, undefined);
    const text2 = buildClassificationText(email, attachment, '   \n  ');

    expect(text1).toContain('Subject: Test Subject');
    expect(text1).not.toContain('---BEGIN PDF TEXT---');
    expect(text2).not.toContain('---BEGIN PDF TEXT---');
  });

  it('includes PDF text section when extracted text is present', () => {
    const email = {
      subject: 'Test Subject',
      from: 'sender@example.com',
      date: new Date('2026-02-07T00:00:00Z'),
    } as any;
    const attachment = { filename: 'receipt.pdf' } as any;

    const out = buildClassificationText(email, attachment, 'hello pdf');

    expect(out).toContain('PDF Text (extracted):');
    expect(out).toContain('---BEGIN PDF TEXT---');
    expect(out).toContain('hello pdf');
    expect(out).toContain('---END PDF TEXT---');
  });
});

