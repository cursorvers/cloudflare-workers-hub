import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { selectAccountItemForReceipt } from './freee-account-selector';

type AnyReceipt = {
  vendor_name: string;
  amount: number;
  transaction_date: string;
  account_category?: string | null;
  tax_type?: string | null;
  tenant_id?: string;
};

type AnyAccountItem = { id: number; name: string };
type AnyTax = { id: number; name: string };

function makeReceipt(overrides: Partial<AnyReceipt> = {}): AnyReceipt {
  return {
    vendor_name: 'Amazon.co.jp',
    amount: 1200,
    transaction_date: '2026-02-08',
    account_category: null,
    tax_type: null,
    tenant_id: 'tenant-1',
    ...overrides,
  };
}

function workersEnvWithResponse(responseText: string, overrides: Record<string, unknown> = {}) {
  return {
    AI: {
      run: vi.fn().mockResolvedValue({ response: responseText }),
    },
    ...overrides,
  } as any;
}

function workersEnvThatThrows(err: unknown, overrides: Record<string, unknown> = {}) {
  return {
    AI: {
      run: vi.fn().mockRejectedValue(err),
    },
    ...overrides,
  } as any;
}

function mockOpenAIOnceJsonContent(content: string) {
  (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      choices: [{ message: { content } }],
    }),
  });
}

function mockOpenAIOnceError(status = 500, text = 'server error') {
  (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
    ok: false,
    status,
    text: async () => text,
  });
}

describe('selectAccountItemForReceipt', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = vi.fn() as any;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('deterministic fallback when env.AI is missing', async () => {
    const env = {} as any;
    const receipt = makeReceipt({ vendor_name: 'Cloudflare', account_category: '通信費' });
    const accountItems: AnyAccountItem[] = [
      { id: 10, name: '消耗品費' },
      { id: 20, name: '通信費' },
      { id: 30, name: '雑費' },
    ];
    const taxes: AnyTax[] = [{ id: 110, name: '課税10%' }];

    const result = await selectAccountItemForReceipt(env, receipt as any, accountItems as any, taxes as any);

    expect(result.provider).toBe('deterministic');
    expect(result.accountItemId).toBe(20);
    expect(result.mappingMethod).toBe('exact');
    expect(result.mappingConfidence).toBeCloseTo(0.98, 5);
    expect(result.reason).toMatch(/deterministic fallback/i);
  });

  it('Workers AI happy path: plain JSON response selects a valid candidate', async () => {
    const env = workersEnvWithResponse(
      JSON.stringify({ chosen_account_item_id: 1, confidence: 0.9, reason: 'カテゴリー一致' })
    );
    const receipt = makeReceipt({ account_category: '消耗品費', vendor_name: 'Amazon' });
    const accountItems: AnyAccountItem[] = [
      { id: 1, name: '消耗品費' },
      { id: 2, name: '通信費' },
    ];
    const taxes: AnyTax[] = [{ id: 10, name: '課税10%' }];

    const result = await selectAccountItemForReceipt(env, receipt as any, accountItems as any, taxes as any);

    expect(result.provider).toBe('workers_ai');
    expect(result.accountItemId).toBe(1);
    expect(result.taxCode).toBe(10);
    expect(result.mappingConfidence).toBeGreaterThan(0.85);
    expect(result.candidateCount).toBeGreaterThan(0);
    expect((env.AI.run as any).mock.calls.length).toBe(1);
  });

  it('Workers AI parses JSON wrapped in a ```json code block', async () => {
    const env = workersEnvWithResponse(
      '```json\n' + JSON.stringify({ chosen_account_item_id: 2, confidence: 0.92, reason: 'hint match' }) + '\n```'
    );
    const receipt = makeReceipt({ account_category: '通信費', vendor_name: 'Cloudflare' });
    const accountItems: AnyAccountItem[] = [
      { id: 1, name: '消耗品費' },
      { id: 2, name: '通信費' },
    ];
    const taxes: AnyTax[] = [{ id: 10, name: '課税10%' }];

    const result = await selectAccountItemForReceipt(env, receipt as any, accountItems as any, taxes as any);

    expect(result.provider).toBe('workers_ai');
    expect(result.accountItemId).toBe(2);
  });

  it('Workers AI parses JSON with extra surrounding text (extractJson finds first object)', async () => {
    const env = workersEnvWithResponse(
      '以下が結果です。\n' +
        JSON.stringify({ chosen_account_item_id: 3, confidence: 0.88, reason: '推定' }) +
        '\n以上です。'
    );
    const receipt = makeReceipt({ account_category: '雑費' });
    const accountItems: AnyAccountItem[] = [
      { id: 3, name: '雑費' },
      { id: 4, name: '会議費' },
    ];
    const taxes: AnyTax[] = [{ id: 10, name: '課税10%' }];

    const result = await selectAccountItemForReceipt(env, receipt as any, accountItems as any, taxes as any);
    expect(result.provider).toBe('workers_ai');
    expect(result.accountItemId).toBe(3);
  });

  it('Workers AI returns invalid candidate id -> deterministic fallback (no OpenAI key)', async () => {
    const env = workersEnvWithResponse(JSON.stringify({ chosen_account_item_id: 999, confidence: 0.99, reason: 'oops' }));
    const receipt = makeReceipt({ vendor_name: 'Amazon', account_category: null });
    const accountItems: AnyAccountItem[] = [
      { id: 1, name: '消耗品費' },
      { id: 2, name: '通信費' },
      { id: 3, name: '雑費' },
    ];
    const taxes: AnyTax[] = [{ id: 10, name: '課税10%' }];

    const result = await selectAccountItemForReceipt(env, receipt as any, accountItems as any, taxes as any);

    expect(result.provider).toBe('deterministic');
    expect(result.accountItemId).toBe(1); // Amazon prior -> 消耗品費 should be baseline
    // Even on invalid choice, reason may come from Workers AI; provider must fail-closed.
    expect(result.reason).toBeDefined();
  });

  it('Workers AI throws -> graceful degradation to deterministic baseline', async () => {
    const env = workersEnvThatThrows(new Error('timeout'));
    const receipt = makeReceipt({ vendor_name: 'Amazon' });
    const accountItems: AnyAccountItem[] = [
      { id: 1, name: '消耗品費' },
      { id: 2, name: '通信費' },
    ];
    const taxes: AnyTax[] = [{ id: 10, name: '課税10%' }];

    const result = await selectAccountItemForReceipt(env, receipt as any, accountItems as any, taxes as any);

    expect(result.provider).toBe('deterministic');
    expect(result.accountItemId).toBe(1);
  });

  it('Workers AI returns invalid JSON (NaN) -> deterministic fallback', async () => {
    const env = workersEnvWithResponse('```json\n{"chosen_account_item_id":1,"confidence":NaN}\n```');
    const receipt = makeReceipt({ vendor_name: 'Amazon' });
    const accountItems: AnyAccountItem[] = [
      { id: 1, name: '消耗品費' },
      { id: 2, name: '通信費' },
    ];
    const taxes: AnyTax[] = [{ id: 10, name: '課税10%' }];

    const result = await selectAccountItemForReceipt(env, receipt as any, accountItems as any, taxes as any);
    expect(result.provider).toBe('deterministic');
    expect(result.accountItemId).toBe(1);
  });

  it('OpenAI escalation when Workers AI confidence < 0.85, with valid OpenAI choice', async () => {
    const env = workersEnvWithResponse(JSON.stringify({ chosen_account_item_id: 1, confidence: 0.2, reason: '低確度' }), {
      OPENAI_API_KEY: 'test-key',
    });
    mockOpenAIOnceJsonContent(JSON.stringify({ chosen_account_item_id: 2, confidence: 0.93, reason: 'より適切' }));

    const receipt = makeReceipt({ vendor_name: 'Cloudflare', account_category: '通信費', amount: 5000 });
    const accountItems: AnyAccountItem[] = [
      { id: 1, name: '消耗品費' },
      { id: 2, name: '通信費' },
    ];
    const taxes: AnyTax[] = [{ id: 10, name: '課税10%' }];

    const result = await selectAccountItemForReceipt(env, receipt as any, accountItems as any, taxes as any);

    expect(result.provider).toBe('openai');
    expect(result.accountItemId).toBe(2);
    expect((globalThis.fetch as any).mock.calls.length).toBe(1);
  });

  it('OpenAI escalation when amount >= 100,000 JPY (high-risk) even if Workers AI is confident', async () => {
    const env = workersEnvWithResponse(JSON.stringify({ chosen_account_item_id: 1, confidence: 0.96, reason: '確信' }), {
      OPENAI_API_KEY: 'test-key',
    });
    mockOpenAIOnceJsonContent(JSON.stringify({ chosen_account_item_id: 2, confidence: 0.9, reason: '高額なので慎重に' }));

    const receipt = makeReceipt({ vendor_name: 'Google', amount: 100_000, account_category: '広告宣伝費' });
    const accountItems: AnyAccountItem[] = [
      { id: 1, name: '広告宣伝費' },
      { id: 2, name: '通信費' },
    ];
    const taxes: AnyTax[] = [{ id: 10, name: '課税10%' }];

    const result = await selectAccountItemForReceipt(env, receipt as any, accountItems as any, taxes as any);

    expect(result.provider).toBe('openai');
    expect((globalThis.fetch as any).mock.calls.length).toBe(1);
  });

  it('OpenAI escalation when scoreGap < 0.06 (ambiguous) even if Workers AI is confident', async () => {
    const env = workersEnvWithResponse(JSON.stringify({ chosen_account_item_id: 101, confidence: 0.95, reason: '上位同率' }), {
      OPENAI_API_KEY: 'test-key',
    });
    mockOpenAIOnceJsonContent(JSON.stringify({ chosen_account_item_id: 102, confidence: 0.9, reason: 'より適切' }));

    const receipt = makeReceipt({ vendor_name: 'Amazon', account_category: '消耗品費', amount: 5000 });
    const accountItems: AnyAccountItem[] = [
      { id: 101, name: '消耗品費' },
      { id: 102, name: '消耗品費' }, // same name -> same score -> gap=0
      { id: 103, name: '雑費' },
    ];
    const taxes: AnyTax[] = [{ id: 10, name: '課税10%' }];

    const result = await selectAccountItemForReceipt(env, receipt as any, accountItems as any, taxes as any);

    expect(result.provider).toBe('openai');
    expect(result.accountItemId).toBe(102);
  });

  it('OpenAI returns invalid id -> falls back to Workers AI result', async () => {
    const env = workersEnvWithResponse(JSON.stringify({ chosen_account_item_id: 2, confidence: 0.3, reason: '低確度' }), {
      OPENAI_API_KEY: 'test-key',
    });
    mockOpenAIOnceJsonContent(JSON.stringify({ chosen_account_item_id: 999, confidence: 0.99, reason: '候補外' }));

    const receipt = makeReceipt({ vendor_name: 'Cloudflare', account_category: '通信費' });
    const accountItems: AnyAccountItem[] = [
      { id: 1, name: '消耗品費' },
      { id: 2, name: '通信費' },
    ];
    const taxes: AnyTax[] = [{ id: 10, name: '課税10%' }];

    const result = await selectAccountItemForReceipt(env, receipt as any, accountItems as any, taxes as any);

    expect(result.provider).toBe('workers_ai');
    expect(result.accountItemId).toBe(2);
    expect((globalThis.fetch as any).mock.calls.length).toBe(1);
  });

  it('OpenAI fails (HTTP error) -> falls back to Workers AI result', async () => {
    const env = workersEnvWithResponse(JSON.stringify({ chosen_account_item_id: 2, confidence: 0.4, reason: '低確度' }), {
      OPENAI_API_KEY: 'test-key',
    });
    mockOpenAIOnceError(500, 'boom');

    const receipt = makeReceipt({ vendor_name: 'Cloudflare', account_category: '通信費' });
    const accountItems: AnyAccountItem[] = [
      { id: 1, name: '消耗品費' },
      { id: 2, name: '通信費' },
    ];
    const taxes: AnyTax[] = [{ id: 10, name: '課税10%' }];

    const result = await selectAccountItemForReceipt(env, receipt as any, accountItems as any, taxes as any);

    expect(result.provider).toBe('workers_ai');
    expect(result.accountItemId).toBe(2);
    expect((globalThis.fetch as any).mock.calls.length).toBe(1);
  });

  it('OpenAI fails and Workers AI choice invalid -> deterministic fallback', async () => {
    const env = workersEnvWithResponse(JSON.stringify({ chosen_account_item_id: 999, confidence: 0.4, reason: '候補外' }), {
      OPENAI_API_KEY: 'test-key',
    });
    mockOpenAIOnceError(503, 'unavailable');

    const receipt = makeReceipt({ vendor_name: 'Amazon', account_category: null });
    const accountItems: AnyAccountItem[] = [
      { id: 1, name: '消耗品費' },
      { id: 2, name: '通信費' },
    ];
    const taxes: AnyTax[] = [{ id: 10, name: '課税10%' }];

    const result = await selectAccountItemForReceipt(env, receipt as any, accountItems as any, taxes as any);

    expect(result.provider).toBe('deterministic');
    expect(result.accountItemId).toBe(1);
  });

  it('Mapping method: substring match yields substring method and bounded score', async () => {
    const env = {} as any;
    const receipt = makeReceipt({ vendor_name: '', account_category: '通信' });
    const accountItems: AnyAccountItem[] = [
      { id: 1, name: '通信費' },
      { id: 2, name: '消耗品費' },
    ];
    const taxes: AnyTax[] = [{ id: 10, name: '課税10%' }];

    const result = await selectAccountItemForReceipt(env, receipt as any, accountItems as any, taxes as any);
    expect(result.provider).toBe('deterministic');
    expect(result.accountItemId).toBe(1);
    expect(result.mappingMethod).toBe('substring');
    expect(result.mappingConfidence).toBeGreaterThanOrEqual(0.72);
    expect(result.mappingConfidence).toBeLessThanOrEqual(0.92);
  });

  it('Mapping method: levenshtein match is used when strings are close but not substrings', async () => {
    const env = {} as any;
    const receipt = makeReceipt({ vendor_name: 'テスト店舗', account_category: 'consumablez' });
    const accountItems: AnyAccountItem[] = [
      { id: 1, name: 'consumables' }, // dist=1, not substring (same length), levScore=0.9 -> capped 0.85
      { id: 2, name: '通信費' },
    ];
    const taxes: AnyTax[] = [{ id: 10, name: '課税10%' }];

    const result = await selectAccountItemForReceipt(env, receipt as any, accountItems as any, taxes as any);
    expect(result.provider).toBe('deterministic');
    expect(result.accountItemId).toBe(1);
    expect(result.mappingMethod).toBe('levenshtein');
    expect(result.mappingConfidence).toBeCloseTo(0.85, 5);
  });

  it('buildCandidates: 雑費 is always boosted to >= 0.6 and can become baseline when no better hints exist', async () => {
    const env = {} as any;
    const receipt = makeReceipt({ vendor_name: '', account_category: '未知カテゴリ' });
    const accountItems: AnyAccountItem[] = [
      { id: 10, name: 'その他' }, // no match -> 0
      { id: 20, name: '雑費' }, // boosted to 0.6
    ];
    const taxes: AnyTax[] = [{ id: 10, name: '課税10%' }];

    const result = await selectAccountItemForReceipt(env, receipt as any, accountItems as any, taxes as any);
    expect(result.provider).toBe('deterministic');
    expect(result.accountItemId).toBe(20);
    expect(result.mappingMethod).toBe('fallback');
    expect(result.mappingConfidence).toBeCloseTo(0.6, 5);
  });

  it('buildCandidates: vendor prior (Amazon) biases baseline toward 消耗品費 even without account_category hint', async () => {
    const env = {} as any;
    const receipt = makeReceipt({ vendor_name: 'Amazon Prime', account_category: null, amount: 0 });
    const accountItems: AnyAccountItem[] = [
      { id: 1, name: '通信費' },
      { id: 2, name: '消耗品費' },
      { id: 3, name: '雑費' },
    ];
    const taxes: AnyTax[] = [{ id: 10, name: '課税10%' }];

    const result = await selectAccountItemForReceipt(env, receipt as any, accountItems as any, taxes as any);
    expect(result.accountItemId).toBe(2);
  });

  it('buildCandidates: when there are no hints, common expense categories are softly preferred', async () => {
    const env = {} as any;
    const receipt = makeReceipt({ vendor_name: '', account_category: null });
    const accountItems: AnyAccountItem[] = [
      { id: 1, name: '旅費交通費' }, // common -> 0.7
      { id: 2, name: 'なにこれ' }, // 0
      { id: 3, name: '雑費' }, // boosted 0.6, but lower than 0.7
    ];
    const taxes: AnyTax[] = [{ id: 10, name: '課税10%' }];

    const result = await selectAccountItemForReceipt(env, receipt as any, accountItems as any, taxes as any);
    expect(result.accountItemId).toBe(1);
    expect(result.mappingMethod).toBe('fallback');
    expect(result.mappingConfidence).toBeCloseTo(0.7, 5);
  });

  it('pickTaxCode: honors receipt.tax_type hint by exact tax name', async () => {
    const env = {} as any;
    const receipt = makeReceipt({ vendor_name: 'Amazon', account_category: '消耗品費', tax_type: '課税8%' });
    const accountItems: AnyAccountItem[] = [{ id: 1, name: '消耗品費' }];
    const taxes: AnyTax[] = [
      { id: 18, name: '課税8%' },
      { id: 10, name: '課税10%' },
    ];

    const result = await selectAccountItemForReceipt(env, receipt as any, accountItems as any, taxes as any);
    expect(result.taxCode).toBe(18);
  });

  it('pickTaxCode: detects 非課税 keywords in category and selects 非課税 tax if present', async () => {
    const env = {} as any;
    const receipt = makeReceipt({ vendor_name: '駅', account_category: '非課税(交通費)', tax_type: null });
    const accountItems: AnyAccountItem[] = [{ id: 1, name: '旅費交通費' }];
    const taxes: AnyTax[] = [
      { id: 11, name: '非課税' },
      { id: 10, name: '課税10%' },
    ];

    const result = await selectAccountItemForReceipt(env, receipt as any, accountItems as any, taxes as any);
    expect(result.taxCode).toBe(11);
  });

  it('pickTaxCode: defaults to 課税10% when taxes include it and no other hint applies', async () => {
    const env = {} as any;
    const receipt = makeReceipt({ vendor_name: 'カフェ', account_category: '会議費', tax_type: null });
    const accountItems: AnyAccountItem[] = [{ id: 1, name: '会議費' }];
    const taxes: AnyTax[] = [
      { id: 11, name: '非課税' },
      { id: 10, name: '課税10%' },
    ];

    const result = await selectAccountItemForReceipt(env, receipt as any, accountItems as any, taxes as any);
    expect(result.taxCode).toBe(10);
  });

  it('pickTaxCode: empty taxes array returns 0', async () => {
    const env = {} as any;
    const receipt = makeReceipt({ vendor_name: 'テスト', account_category: '消耗品費' });
    const accountItems: AnyAccountItem[] = [{ id: 1, name: '消耗品費' }];
    const taxes: AnyTax[] = [];

    const result = await selectAccountItemForReceipt(env, receipt as any, accountItems as any, taxes as any);
    expect(result.taxCode).toBe(0);
  });

  it('computeMappingConfidence: applies ambiguous gap penalty (x0.85) when scoreGap < 0.06', async () => {
    // No OpenAI key so escalation won't switch provider; we still get workers_ai back.
    const env = workersEnvWithResponse(JSON.stringify({ chosen_account_item_id: 1, confidence: 1, reason: '同率' }));
    const receipt = makeReceipt({ vendor_name: 'Amazon', account_category: '消耗品費', amount: 999 });
    const accountItems: AnyAccountItem[] = [
      { id: 1, name: '消耗品費' },
      { id: 2, name: '消耗品費' }, // same score -> gap=0 (ambiguous)
    ];
    const taxes: AnyTax[] = [{ id: 10, name: '課税10%' }];

    const result = await selectAccountItemForReceipt(env, receipt as any, accountItems as any, taxes as any);
    expect(result.provider).toBe('workers_ai');
    // (1.0 + 0.98) / 2 * 0.85 = 0.8415
    expect(result.mappingConfidence).toBeCloseTo(0.8415, 4);
    expect(result.scoreGap).toBeLessThan(0.06);
  });

  it('candidate list is capped at 20 items', async () => {
    const env = {} as any;
    const receipt = makeReceipt({ vendor_name: 'Amazon', account_category: null });
    const accountItems: AnyAccountItem[] = Array.from({ length: 50 }, (_, i) => ({
      id: i + 1,
      name: i === 0 ? '消耗品費' : `カテゴリ${i + 1}`,
    }));
    const taxes: AnyTax[] = [{ id: 10, name: '課税10%' }];

    const result = await selectAccountItemForReceipt(env, receipt as any, accountItems as any, taxes as any);
    expect(result.candidateCount).toBeLessThanOrEqual(20);
  });

  it('empty accountItems still returns a result (fail-closed)', async () => {
    const env = {} as any;
    const receipt = makeReceipt({ vendor_name: '', account_category: null, amount: 0 });

    const result = await selectAccountItemForReceipt(env, receipt as any, [] as any, [] as any);
    expect(result.provider).toBe('deterministic');
    expect(result.accountItemId).toBe(0);
    expect(result.candidateCount).toBe(0);
    expect(result.mappingConfidence).toBeGreaterThan(0);
  });
});
