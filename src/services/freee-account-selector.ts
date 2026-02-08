/**
 * freee Account Selector (Hybrid LLM)
 *
 * Goal:
 * - Choose the best `account_item_id` from freee `account_items` for an expense receipt.
 *
 * Design:
 * - Build a small candidate list (Top N) deterministically.
 * - Primary: Workers AI selects within candidates.
 * - Escalation: OpenAI selects within candidates when Workers AI is low-confidence / ambiguous / high-risk.
 * - Fail-closed: if selection is invalid/low-confidence, mark as needs_review in the caller.
 */

import { z } from 'zod';
import type { Env } from '../types';
import { safeLog } from '../utils/log-sanitizer';
import type { FreeeAccountItem, FreeeTax } from './freee-master-cache';

// =============================================================================
// Types
// =============================================================================

export type SelectionProvider = 'deterministic' | 'workers_ai' | 'openai';

export type MappingMethod = 'exact' | 'substring' | 'levenshtein' | 'fallback' | 'manual';

export interface AccountSelectionResult {
  accountItemId: number;
  taxCode: number;
  mappingConfidence: number; // 0.0-1.0 (used for auto-deal thresholding)
  mappingMethod: MappingMethod; // persisted to receipts.account_mapping_method
  provider: SelectionProvider;
  reason?: string;
  candidateCount: number;
  scoreGap: number; // topScore - secondScore in candidate scoring
}

export interface ReceiptForAccountSelection {
  vendor_name: string;
  amount: number;
  transaction_date: string;
  account_category?: string | null;
  tax_type?: string | null;
  tenant_id?: string;
}

// =============================================================================
// Constants (tuneable; keep conservative defaults)
// =============================================================================

const CANDIDATE_LIMIT = 20;
const WORKERS_MODEL = '@cf/meta/llama-3.2-3b-instruct';
const OPENAI_MODEL = 'gpt-4o-mini';
const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';

const WORKERS_TIMEOUT_MS = 12_000;
const OPENAI_TIMEOUT_MS = 25_000;

// Escalate to OpenAI if Workers AI confidence is below this.
const WORKERS_CONFIDENCE_ESCALATE = 0.85;
// If top-2 candidates are too close, treat as ambiguous.
const SCORE_GAP_AMBIGUOUS = 0.06;
// High-risk amount (JPY). Above this, we prefer higher-quality model or review.
const HIGH_AMOUNT_JPY = 100_000;

// Tax selection defaults (freee tax names vary by account setup but commonly these exist).
const DEFAULT_TAX_NAME = '課税10%';
const NON_TAX_NAME = '非課税';
const NON_TAXABLE_KEYWORDS = ['非課税', '不課税', '免税', '対象外'];

// When we have no hint, include commonly-used expense categories if present.
const COMMON_EXPENSE_CATEGORIES = [
  '消耗品費',
  '通信費',
  '支払手数料',
  '広告宣伝費',
  '旅費交通費',
  '会議費',
  '外注費',
  '地代家賃',
  '水道光熱費',
  '雑費',
] as const;

// Vendor priors (best-effort; org-specific. Used only for candidate scoring, not hard decisions.)
const VENDOR_PRIORS: Array<{ pattern: RegExp; category: string }> = [
  { pattern: /amazon|アマゾン/i, category: '消耗品費' },
  { pattern: /cloudflare/i, category: '通信費' },
  { pattern: /stripe/i, category: '支払手数料' },
  { pattern: /google|グーグル/i, category: '広告宣伝費' },
];

// =============================================================================
// Helpers
// =============================================================================

const SelectionSchema = z.object({
  chosen_account_item_id: z.number().int().nonnegative(),
  confidence: z.number().min(0).max(1),
  reason: z.string().max(300).optional(),
});

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function normalize(s: string): string {
  return s.trim().toLowerCase();
}

function levenshteinDistance(a: string, b: string): number {
  const aLen = a.length;
  const bLen = b.length;
  if (aLen === 0) return bLen;
  if (bLen === 0) return aLen;

  const matrix: number[][] = Array.from({ length: aLen + 1 }, () =>
    Array.from({ length: bLen + 1 }, () => 0)
  );
  for (let i = 0; i <= aLen; i += 1) matrix[i][0] = i;
  for (let j = 0; j <= bLen; j += 1) matrix[0][j] = j;

  for (let i = 1; i <= aLen; i += 1) {
    for (let j = 1; j <= bLen; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }
  return matrix[aLen][bLen];
}

function scoreNameMatch(hint: string, itemName: string): { score: number; method: MappingMethod } {
  const h = normalize(hint);
  const n = normalize(itemName);
  if (!h) return { score: 0, method: 'fallback' };

  if (h === n) return { score: 0.98, method: 'exact' };

  if (n.includes(h) || h.includes(n)) {
    const ratio = Math.min(n.length, h.length) / Math.max(n.length, h.length || 1);
    const score = Math.max(0.72, Math.min(0.92, ratio + 0.1));
    return { score, method: 'substring' };
  }

  const dist = levenshteinDistance(h, n);
  const maxLen = Math.max(h.length, n.length, 1);
  const levScore = 1 - dist / maxLen;
  if (levScore >= 0.5) {
    return { score: Math.min(0.85, levScore), method: 'levenshtein' };
  }
  return { score: 0, method: 'fallback' };
}

function deriveHintCategories(receipt: ReceiptForAccountSelection): string[] {
  const hints: string[] = [];
  if (receipt.account_category && receipt.account_category.trim()) {
    hints.push(receipt.account_category.trim());
  }
  const vendor = receipt.vendor_name || '';
  for (const prior of VENDOR_PRIORS) {
    if (prior.pattern.test(vendor)) {
      hints.push(prior.category);
    }
  }
  // De-dup (normalized)
  const seen = new Set<string>();
  const out: string[] = [];
  for (const h of hints) {
    const key = normalize(h);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(h);
  }
  return out;
}

function pickTaxCode(taxes: readonly FreeeTax[], receipt: ReceiptForAccountSelection, chosenAccountName: string): number {
  if (taxes.length === 0) return 0;

  // If we already have a tax_type hint (e.g., from AI classification), try to honor it by name.
  const hinted = receipt.tax_type?.trim();
  if (hinted) {
    const normalized = normalize(hinted);
    const exact = taxes.find((t) => normalize(String(t.name ?? '')) === normalized);
    if (exact) return exact.id;
  }

  const normalizedCategory = normalize(receipt.account_category ?? chosenAccountName ?? '');
  const isNonTaxable = NON_TAXABLE_KEYWORDS.some((k) => normalizedCategory.includes(normalize(k)));
  const desired = isNonTaxable ? NON_TAX_NAME : DEFAULT_TAX_NAME;
  const match = taxes.find((t) => normalize(String(t.name ?? '')) === normalize(desired));
  return (match ?? taxes[0])?.id ?? 0;
}

type Candidate = {
  id: number;
  name: string;
  score: number;
  method: MappingMethod;
};

function buildCandidates(
  receipt: ReceiptForAccountSelection,
  accountItems: readonly FreeeAccountItem[]
): { candidates: Candidate[]; scoreGap: number } {
  const hints = deriveHintCategories(receipt);

  const scored: Candidate[] = accountItems.map((item) => {
    const name = String(item.name ?? '');
    let best = { score: 0, method: 'fallback' as MappingMethod };
    for (const h of hints) {
      const s = scoreNameMatch(h, name);
      if (s.score > best.score) best = s;
    }

    // If no hints exist, softly prefer common expense categories (if they exist in master).
    if (hints.length === 0) {
      for (const common of COMMON_EXPENSE_CATEGORIES) {
        if (normalize(name) === normalize(common)) {
          best = { score: Math.max(best.score, 0.7), method: 'fallback' };
          break;
        }
      }
    }

    return { id: item.id, name, score: best.score, method: best.method };
  });

  // Always include 雑費 if present as a safe fallback candidate.
  const zappi = scored.find((c) => normalize(c.name) === normalize('雑費'));
  if (zappi) {
    zappi.score = Math.max(zappi.score, 0.6);
    zappi.method = zappi.method === 'fallback' ? 'fallback' : zappi.method;
  }

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, CANDIDATE_LIMIT);
  const gap = top.length >= 2 ? Math.max(0, top[0].score - top[1].score) : 1;

  // Ensure we always return at least 1 candidate.
  if (top.length === 0 && accountItems.length > 0) {
    top.push({ id: accountItems[0].id, name: String(accountItems[0].name ?? ''), score: 0.5, method: 'fallback' });
  }

  return { candidates: top, scoreGap: gap };
}

function extractJson(text: string): unknown {
  let jsonStr = text.trim();
  // Regex literal: use single backslashes for whitespace/classes.
  const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    jsonStr = codeBlockMatch[1].trim();
  }

  // If there's extra text, try to extract the first JSON object.
  const firstBrace = jsonStr.indexOf('{');
  const lastBrace = jsonStr.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    jsonStr = jsonStr.slice(firstBrace, lastBrace + 1);
  }

  return JSON.parse(jsonStr);
}

function computeMappingConfidence(llmConfidence: number, chosenCandidateScore: number, scoreGap: number): number {
  let combined = (clamp01(llmConfidence) + clamp01(chosenCandidateScore)) / 2;
  if (scoreGap < SCORE_GAP_AMBIGUOUS) {
    combined *= 0.85;
  }
  return clamp01(combined);
}

function isHighRisk(receipt: ReceiptForAccountSelection, scoreGap: number): boolean {
  const amount = Number.isFinite(receipt.amount) ? receipt.amount : 0;
  return amount >= HIGH_AMOUNT_JPY || scoreGap < SCORE_GAP_AMBIGUOUS;
}

async function selectWithWorkersAI(
  env: Env,
  receipt: ReceiptForAccountSelection,
  candidates: Candidate[]
): Promise<z.infer<typeof SelectionSchema>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WORKERS_TIMEOUT_MS);

  try {
    const system = `あなたは日本の経理業務の補助者です。領収書の内容から、最も適切な勘定科目を選びます。

制約:
- 必ず候補リスト内の account_item_id を1つ選ぶこと（候補外は絶対に選ばない）
- 回答はJSONのみ

出力JSON:
{
  "chosen_account_item_id": number,
  "confidence": 0.0-1.0,
  "reason": "短い理由"
}`;

    const user = [
      `領収書情報:`,
      `- vendor_name: ${receipt.vendor_name}`,
      `- amount_jpy: ${receipt.amount}`,
      `- transaction_date: ${receipt.transaction_date}`,
      receipt.account_category ? `- hint_account_category: ${receipt.account_category}` : null,
      '',
      `候補(選べるのはこの中だけ):`,
      JSON.stringify(candidates.map((c) => ({ id: c.id, name: c.name }))),
    ]
      .filter(Boolean)
      .join('\n');

    const ai = env.AI;
    const response = await (ai.run as (model: string, input: unknown, options?: unknown) => Promise<unknown>)(
      WORKERS_MODEL,
      {
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        max_tokens: 256,
        temperature: 0.1,
      },
      { signal: controller.signal }
    );

    const aiText = (response as { response?: string })?.response;
    if (!aiText) throw new Error('Empty response from Workers AI');

    const parsed = SelectionSchema.parse(extractJson(aiText));
    return parsed;
  } finally {
    clearTimeout(timeout);
  }
}

async function selectWithOpenAI(
  apiKey: string,
  receipt: ReceiptForAccountSelection,
  candidates: Candidate[]
): Promise<z.infer<typeof SelectionSchema>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);

  try {
    const system = `You are a careful accounting assistant for Japan.
Choose the single best account item from the provided candidates for an EXPENSE receipt.

Hard rules:
- You MUST choose an id that exists in the candidate list.
- Output JSON only.

Output JSON schema:
{
  "chosen_account_item_id": number,
  "confidence": number (0.0-1.0),
  "reason": string
}`;

    const user = [
      `Receipt:`,
      `vendor_name: ${receipt.vendor_name}`,
      `amount_jpy: ${receipt.amount}`,
      `transaction_date: ${receipt.transaction_date}`,
      receipt.account_category ? `hint_account_category: ${receipt.account_category}` : null,
      '',
      `Candidates:`,
      JSON.stringify(candidates.map((c) => ({ id: c.id, name: c.name }))),
    ]
      .filter(Boolean)
      .join('\n');

    const res = await fetch(OPENAI_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        max_tokens: 256,
        temperature: 0.1,
        response_format: { type: 'json_object' },
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`OpenAI API error (${res.status}): ${errorText}`);
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const aiText = data.choices?.[0]?.message?.content;
    if (!aiText) throw new Error('Empty response from OpenAI');

    return SelectionSchema.parse(extractJson(aiText));
  } finally {
    clearTimeout(timeout);
  }
}

// =============================================================================
// Public API
// =============================================================================

export async function selectAccountItemForReceipt(
  env: Env,
  receipt: ReceiptForAccountSelection,
  accountItems: readonly FreeeAccountItem[],
  taxes: readonly FreeeTax[]
): Promise<AccountSelectionResult> {
  const { candidates, scoreGap } = buildCandidates(receipt, accountItems);
  const candidateIds = new Set(candidates.map((c) => c.id));

  // Baseline deterministic "best guess" (used for fail-closed fallback only).
  const baseline = candidates[0] ?? { id: 0, name: '', score: 0.5, method: 'fallback' as MappingMethod };

  // If AI binding is missing (tests/local edge), degrade gracefully to deterministic selection.
  if (!env.AI) {
    const taxCode = pickTaxCode(taxes, receipt, baseline.name);
    return {
      accountItemId: baseline.id,
      taxCode,
      mappingConfidence: clamp01(baseline.score),
      mappingMethod: baseline.method,
      provider: 'deterministic',
      reason: 'AI unavailable; deterministic fallback',
      candidateCount: candidates.length,
      scoreGap,
    };
  }

  // 1) Workers AI selection (default)
  let workers: z.infer<typeof SelectionSchema> | null = null;
  try {
    workers = await selectWithWorkersAI(env, receipt, candidates);
  } catch (e) {
    safeLog(env, 'warn', '[AccountSelector] Workers AI selection failed', { error: String(e) });
  }

  const isValidWorkersChoice =
    workers !== null && candidateIds.has(workers.chosen_account_item_id);

  const chosenFromWorkers = isValidWorkersChoice
    ? candidates.find((c) => c.id === workers!.chosen_account_item_id) ?? baseline
    : baseline;

  const workersConf = workers?.confidence ?? 0;
  const workersMappingConfidence = computeMappingConfidence(workersConf, chosenFromWorkers.score, scoreGap);

  const shouldEscalate =
    !isValidWorkersChoice ||
    workersConf < WORKERS_CONFIDENCE_ESCALATE ||
    isHighRisk(receipt, scoreGap);

  // 2) OpenAI escalation (only when configured + necessary)
  if (shouldEscalate && env.OPENAI_API_KEY) {
    let openai: z.infer<typeof SelectionSchema> | null = null;
    try {
      openai = await selectWithOpenAI(env.OPENAI_API_KEY, receipt, candidates);
    } catch (e) {
      safeLog(env, 'warn', '[AccountSelector] OpenAI selection failed (continuing with Workers/baseline)', {
        error: String(e),
      });
    }

    const isValidOpenAIChoice =
      openai !== null && candidateIds.has(openai.chosen_account_item_id);

    if (isValidOpenAIChoice) {
      const chosen = candidates.find((c) => c.id === openai!.chosen_account_item_id) ?? baseline;
      const mappingConfidence = computeMappingConfidence(openai!.confidence, chosen.score, scoreGap);
      const taxCode = pickTaxCode(taxes, receipt, chosen.name);
      return {
        accountItemId: chosen.id,
        taxCode,
        mappingConfidence,
        mappingMethod: chosen.method,
        provider: 'openai',
        reason: openai!.reason ?? 'OpenAI selected from candidates',
        candidateCount: candidates.length,
        scoreGap,
      };
    }
  }

  // Workers AI result (or deterministic fallback if invalid)
  const taxCode = pickTaxCode(taxes, receipt, chosenFromWorkers.name);
  return {
    accountItemId: chosenFromWorkers.id,
    taxCode,
    mappingConfidence: isValidWorkersChoice ? workersMappingConfidence : clamp01(baseline.score),
    mappingMethod: chosenFromWorkers.method,
    provider: isValidWorkersChoice ? 'workers_ai' : 'deterministic',
    reason: workers?.reason ?? (isValidWorkersChoice ? 'Workers AI selected from candidates' : 'Invalid choice; deterministic fallback'),
    candidateCount: candidates.length,
    scoreGap,
  };
}
