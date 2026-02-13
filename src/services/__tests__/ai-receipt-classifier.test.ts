import { describe, expect, it } from 'vitest';
import { classifyReceipt } from '../ai-receipt-classifier';

describe('ai-receipt-classifier (rule-based extraction)', () => {
  it('prefers USD when $ exists even if Total keyword is present', async () => {
    const env: any = {};

    // Vendor rule triggers rule_based path; amount extraction should not default to JPY
    // when the same receipt clearly contains $.
    const text = [
      'Cloudflare Invoice',
      'Total 25.00',
      '$25.00',
      'Thank you',
    ].join('\n');

    const res = await classifyReceipt(env, text, {});
    expect(res.method).toBe('rule_based');
    expect(res.currency).toBe('USD');
    expect(res.amount).toBe(25);
  });

  it('extracts JPY from yen markers', async () => {
    const env: any = {};
    const text = [
      'Cloudflare 領収書',
      '合計 1,234円',
    ].join('\n');

    const res = await classifyReceipt(env, text, {});
    expect(res.method).toBe('rule_based');
    expect(res.currency).toBe('JPY');
    expect(res.amount).toBe(1234);
  });
});
