/**
 * AI Receipt Classifier
 *
 * Uses Workers AI (Llama 3.2 3B) for receipt classification
 * - Document type classification
 * - Vendor name extraction
 * - Amount extraction
 * - Account category suggestion
 *
 * Cost Optimization:
 * - 3B model (99% cost reduction vs 70B)
 * - 30-day KV caching (70% reduction in AI calls)
 * - Target: $10/month for 7,000 receipts/day
 */

import type { Env } from '../types';
import { safeLog } from '../utils/log-sanitizer';
import { CONFIDENCE } from '../config/confidence-thresholds';

// =============================================================================
// Types
// =============================================================================

export interface ClassificationResult {
  document_type: 'invoice' | 'receipt' | 'expense_report' | 'other';
  vendor_name: string;
  amount: number;
  currency: string;
  transaction_date: string;
  account_category?: string;
  tax_type?: string;
  department?: string;
  confidence: number; // 0.0-1.0
  method: 'rule_based' | 'ai_assisted';
  cache_hit: boolean;
  /** Whether amount was explicitly extracted (true) vs defaulted to 0 (false). */
  amount_extracted: boolean;
}

interface RuleBasedResult {
  matched: boolean;
  result?: Partial<ClassificationResult>;
}

// =============================================================================
// Amount / Date Extraction Helpers
// =============================================================================

/**
 * Extract amount (JPY) from text using regex patterns.
 * Returns { amount, extracted } where extracted=true if a pattern matched.
 */
function extractAmount(text: string): { amount: number; extracted: boolean } {
  const patterns = [
    // ¥1,234 or ￥1,234
    /[¥￥]\s*([\d,]+)/,
    // 1,234円
    /([\d,]+)\s*円/,
    // JPY 1234
    /JPY\s*([\d,]+)/i,
    // 合計 1,234 / Total 1,234 / Amount: 1,234
    /(?:合計|total|amount|金額|請求額|お支払い)[:\s]*([\d,]+)/i,
    // $12.34 (foreign currency; amount is still extracted but currency must be handled separately)
    /\$\s*([\d,.]+)/,
  ];

  const detectedCurrency = detectCurrency(text);

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const raw = match[1].replace(/,/g, '');
      const parsed = Number.parseFloat(raw);
      // Preserve decimal precision for non-JPY currencies (e.g. $12.34)
      const amount = detectedCurrency === 'JPY'
        ? Math.round(parsed)
        : Math.round(parsed * 100) / 100;
      if (Number.isFinite(amount) && amount > 0) {
        return { amount, extracted: true };
      }
    }
  }
  return { amount: 0, extracted: false };
}

function detectCurrency(text: string): string {
  if (/[¥￥]|\bJPY\b/i.test(text)) return 'JPY';
  if (/\$|\bUSD\b/i.test(text)) return 'USD';
  return 'JPY';
}

/**
 * Extract transaction date from text.
 * Returns ISO date string or null.
 */
function extractDate(text: string): string | null {
  const patterns: Array<{ regex: RegExp; format: (m: RegExpMatchArray) => string }> = [
    // 2026-02-09
    { regex: /(\d{4})-(\d{2})-(\d{2})/, format: (m) => `${m[1]}-${m[2]}-${m[3]}` },
    // 2026/02/09
    { regex: /(\d{4})\/(\d{1,2})\/(\d{1,2})/, format: (m) => `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` },
    // 2026年2月9日
    { regex: /(\d{4})年(\d{1,2})月(\d{1,2})日/, format: (m) => `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` },
    // Feb 9, 2026
    { regex: /(\w{3})\s+(\d{1,2}),?\s+(\d{4})/, format: (m) => {
      const months: Record<string, string> = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
      const month = months[m[1]];
      return month ? `${m[3]}-${month}-${m[2].padStart(2, '0')}` : '';
    }},
  ];

  for (const { regex, format } of patterns) {
    const match = text.match(regex);
    if (match) {
      const date = format(match);
      if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return date;
      }
    }
  }
  return null;
}

// =============================================================================
// Rule-Based Classification (Primary)
// =============================================================================

interface VendorRule {
  pattern: RegExp;
  vendor_name: string;
  account_category: string;
  confidence: number;
}

/**
 * Vendor rules for rule-based classification.
 * Sorted by specificity (most specific patterns first).
 */
const VENDOR_RULES: VendorRule[] = [
  // Communication / Internet
  { pattern: /cloudflare/i, vendor_name: 'Cloudflare Inc.', account_category: '通信費', confidence: 0.95 },
  { pattern: /aws|amazon\s*web\s*services/i, vendor_name: 'Amazon Web Services', account_category: '通信費', confidence: 0.95 },
  { pattern: /digitalocean/i, vendor_name: 'DigitalOcean', account_category: '通信費', confidence: 0.95 },
  { pattern: /heroku/i, vendor_name: 'Heroku', account_category: '通信費', confidence: 0.95 },
  { pattern: /vercel/i, vendor_name: 'Vercel Inc.', account_category: '通信費', confidence: 0.95 },
  { pattern: /netlify/i, vendor_name: 'Netlify', account_category: '通信費', confidence: 0.90 },
  { pattern: /さくらインターネット|sakura.*internet/i, vendor_name: 'さくらインターネット', account_category: '通信費', confidence: 0.90 },
  { pattern: /twilio/i, vendor_name: 'Twilio', account_category: '通信費', confidence: 0.90 },

  // Advertising
  { pattern: /google\s*ads|google\s*広告/i, vendor_name: 'Google Ads', account_category: '広告宣伝費', confidence: 0.95 },
  { pattern: /meta\s*ads|facebook\s*ads/i, vendor_name: 'Meta Platforms', account_category: '広告宣伝費', confidence: 0.95 },
  { pattern: /google|グーグル/i, vendor_name: 'Google LLC', account_category: '広告宣伝費', confidence: 0.90 },

  // Payment Fees
  { pattern: /stripe/i, vendor_name: 'Stripe Inc.', account_category: '支払手数料', confidence: 0.95 },
  { pattern: /paypal/i, vendor_name: 'PayPal', account_category: '支払手数料', confidence: 0.95 },
  { pattern: /square/i, vendor_name: 'Square', account_category: '支払手数料', confidence: 0.90 },

  // Supplies / Software
  { pattern: /amazon|アマゾン/i, vendor_name: 'Amazon.co.jp', account_category: '消耗品費', confidence: 0.90 },
  { pattern: /apple/i, vendor_name: 'Apple Inc.', account_category: '消耗品費', confidence: 0.90 },
  { pattern: /microsoft|マイクロソフト/i, vendor_name: 'Microsoft', account_category: '消耗品費', confidence: 0.90 },
  { pattern: /jetbrains/i, vendor_name: 'JetBrains', account_category: '消耗品費', confidence: 0.90 },
  { pattern: /adobe/i, vendor_name: 'Adobe', account_category: '消耗品費', confidence: 0.90 },
  { pattern: /github/i, vendor_name: 'GitHub', account_category: '消耗品費', confidence: 0.90 },
  { pattern: /notion/i, vendor_name: 'Notion', account_category: '消耗品費', confidence: 0.85 },
  { pattern: /openai/i, vendor_name: 'OpenAI', account_category: '消耗品費', confidence: 0.90 },
  { pattern: /anthropic/i, vendor_name: 'Anthropic', account_category: '消耗品費', confidence: 0.90 },
  { pattern: /figma/i, vendor_name: 'Figma', account_category: '消耗品費', confidence: 0.85 },
  { pattern: /slack/i, vendor_name: 'Slack', account_category: '消耗品費', confidence: 0.85 },

  // Travel / Transport
  { pattern: /ANA|全日空/i, vendor_name: 'ANA', account_category: '旅費交通費', confidence: 0.90 },
  { pattern: /JAL|日本航空/i, vendor_name: 'JAL', account_category: '旅費交通費', confidence: 0.90 },
  { pattern: /suica|pasmo|icoca/i, vendor_name: '交通系IC', account_category: '旅費交通費', confidence: 0.85 },
  { pattern: /タクシー|taxi|uber/i, vendor_name: 'タクシー', account_category: '旅費交通費', confidence: 0.85 },

  // Outsourcing
  { pattern: /ランサーズ|lancers/i, vendor_name: 'ランサーズ', account_category: '外注費', confidence: 0.90 },
  { pattern: /クラウドワークス|crowdworks/i, vendor_name: 'クラウドワークス', account_category: '外注費', confidence: 0.90 },
  { pattern: /upwork/i, vendor_name: 'Upwork', account_category: '外注費', confidence: 0.90 },

  // Meeting
  { pattern: /zoom/i, vendor_name: 'Zoom', account_category: '会議費', confidence: 0.85 },

  // Misc
  { pattern: /cotobox/i, vendor_name: 'cotobox', account_category: '雑費', confidence: 0.85 },
];

/**
 * Attempt rule-based classification first.
 * Now also extracts amount and date from text.
 */
function tryRuleBasedClassification(
  text: string,
  _metadata: Record<string, unknown>
): RuleBasedResult {
  for (const rule of VENDOR_RULES) {
    if (rule.pattern.test(text)) {
      const { amount, extracted: amountExtracted } = extractAmount(text);
      const date = extractDate(text);

      return {
        matched: true,
        result: {
          vendor_name: rule.vendor_name,
          account_category: rule.account_category,
          confidence: rule.confidence,
          method: 'rule_based',
          amount,
          amount_extracted: amountExtracted,
          ...(date ? { transaction_date: date } : {}),
        },
      };
    }
  }

  return { matched: false };
}

// =============================================================================
// AI Classification (Fallback)
// =============================================================================

/**
 * Calculate SHA-256 hash for caching
 */
async function calculateHash(data: string): Promise<string> {
  const encoder = new TextEncoder();
  const buffer = await crypto.subtle.digest('SHA-256', encoder.encode(data));
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function getClassificationCacheTenant(metadata: Record<string, any>): string {
  const tenant = metadata?.tenantId ?? metadata?.tenant_id;
  return typeof tenant === 'string' && tenant.length > 0 ? tenant : 'default';
}

function normalizeClassificationMetadataForPrompt(metadata: Record<string, any>): Record<string, any> {
  // Avoid feeding volatile identifiers into the model; they also destroy cache hit rate.
  // Keep only signal-like fields; callers can still pass IDs via logs/workflow metadata.
  const {
    messageId,
    attachmentId,
    receiptId,
    emailDate,
    // Keep pdfText* out of the model prompt to avoid accidental prompt steering.
    pdfTextExtracted,
    pdfTextPages,
    pdfTextElapsedMs,
    pdfTextReason,
    ...rest
  } = metadata || {};

  return rest;
}

/**
 * Call Workers AI for classification
 */
async function classifyWithAI(
  env: Env,
  text: string,
  metadata: Record<string, any>
): Promise<ClassificationResult> {
  const promptMetadata = normalizeClassificationMetadataForPrompt(metadata);
  const prompt = `Analyze this receipt/invoice and extract structured information.

Receipt Text:
${text}

Metadata:
${JSON.stringify(promptMetadata, null, 2)}

  Extract and return ONLY a JSON object with the following structure:
  {
    "document_type": "invoice" | "receipt" | "expense_report" | "other",
    "vendor_name": "exact vendor name",
    "amount": number (no comma; keep the receipt's currency),
    "currency": "JPY" | "USD",
    "transaction_date": "YYYY-MM-DD",
    "account_category": "勘定科目 (e.g., 消耗品費, 広告宣伝費, 通信費)",
    "tax_type": "課税区分 (e.g., 課税10%, 非課税)",
    "confidence": 0.0-1.0
  }`;

  const response = await env.AI.run('@cf/meta/llama-3.2-3b-instruct', {
    prompt,
    max_tokens: 300,
    temperature: 0.1, // Low temperature for deterministic output
  });

  // Parse AI response
  let aiResult: any;
  try {
    // Extract JSON from markdown code blocks if present (tolerant: case-insensitive, optional newlines, CRLF)
    const jsonMatch = response.response?.match(/```(?:json|JSON)?\s*([\s\S]*?)\s*```/);
    let jsonStr = jsonMatch ? jsonMatch[1] : response.response;
    // Fallback: extract first { ... } block if no code block matched
    if (!jsonStr || jsonStr.trim()[0] !== '{') {
      const braceMatch = response.response?.match(/\{[\s\S]*\}/);
      if (braceMatch) jsonStr = braceMatch[0];
    }
    aiResult = JSON.parse(jsonStr || '{}');
  } catch (error) {
    safeLog(env, 'error', 'AI response parsing failed', {
      response,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    throw new Error('AI response parsing failed');
  }

  const aiAmount = typeof aiResult.amount === 'number' ? aiResult.amount : 0;
  const currencyFromText = detectCurrency(text);
  const currencyRaw = typeof aiResult.currency === 'string' ? aiResult.currency.trim().toUpperCase() : '';
  const currency = currencyRaw === 'JPY' || currencyRaw === 'USD' ? currencyRaw : currencyFromText;

  // Validate document_type against whitelist (fallback to 'other')
  const VALID_DOC_TYPES = ['invoice', 'receipt', 'expense_report', 'other'] as const;
  const rawDocType = typeof aiResult.document_type === 'string' ? aiResult.document_type.toLowerCase() : 'other';
  const document_type = (VALID_DOC_TYPES as readonly string[]).includes(rawDocType)
    ? rawDocType as ClassificationResult['document_type']
    : 'other';

  // Fix: confidence 0.0 is valid — use typeof check instead of falsy || operator
  const confidence = typeof aiResult.confidence === 'number'
    ? Math.max(0, Math.min(1, aiResult.confidence))
    : 0.5;

  return {
    document_type,
    vendor_name: aiResult.vendor_name || 'Unknown',
    amount: aiAmount,
    currency,
    transaction_date: aiResult.transaction_date || new Date().toISOString().split('T')[0],
    account_category: aiResult.account_category,
    tax_type: aiResult.tax_type,
    confidence,
    method: 'ai_assisted',
    cache_hit: false,
    amount_extracted: aiAmount > 0,
  };
}

// =============================================================================
// Gemini API Classification (Escalation Fallback)
// =============================================================================

const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';

/**
 * Determine if Workers AI result should escalate to Gemini.
 * Triggers: amount=0, low confidence, parse failure.
 */
function shouldEscalateToGemini(
  result: ClassificationResult,
  env: Env,
): boolean {
  if (!env.GEMINI_API_KEY) return false;
  if (!result.amount_extracted) return true; // amount=0 → most critical
  if (result.confidence < CONFIDENCE.WORKERS_ESCALATE) return true;
  if (result.vendor_name === 'Unknown') return true;
  return false;
}

/**
 * Call Gemini API for higher-quality receipt classification.
 * Uses text-only mode (multimodal PDF support in Phase 3).
 */
async function classifyWithGemini(
  env: Env,
  text: string,
  metadata: Record<string, any>,
  previousResult?: ClassificationResult,
): Promise<ClassificationResult> {
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not configured');

  const promptMetadata = normalizeClassificationMetadataForPrompt(metadata);
  const previousHint = previousResult
    ? `\nPrevious extraction attempt returned amount=0. Please re-analyze carefully.`
    : '';

  const prompt = `You are a Japanese accounting receipt analyzer. Extract structured data from this receipt/invoice.${previousHint}

Receipt Text:
${text}

Metadata:
${JSON.stringify(promptMetadata, null, 2)}

IMPORTANT:
- Extract the GRAND TOTAL amount (not subtotals or line items)
- For USD amounts, keep the original USD value (do NOT convert to JPY)
- If amount is genuinely 0 or free, set amount to 0 and amount_extracted to true
- If you cannot determine the amount, set amount to 0 and amount_extracted to false

Return ONLY a valid JSON object:
{
  "document_type": "invoice" | "receipt" | "expense_report" | "other",
  "vendor_name": "exact vendor name",
  "amount": number,
  "currency": "JPY" | "USD",
  "transaction_date": "YYYY-MM-DD",
  "account_category": "勘定科目 (e.g., 消耗品費, 通信費)",
  "tax_type": "課税区分 (e.g., 課税10%, 非課税)",
  "confidence": 0.0-1.0,
  "amount_extracted": true | false
}`;

  const response = await fetch(`${GEMINI_API_URL}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 500,
      },
    }),
    signal: AbortSignal.timeout(15_000), // 15s timeout
  });

  if (!response.ok) {
    const status = response.status;
    safeLog(env, 'warn', 'Gemini API error', { status });
    throw new Error(`Gemini API returned ${status}`);
  }

  const body = await response.json() as any;
  const responseText = body?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';

  // Parse JSON from Gemini response
  let geminiResult: any;
  try {
    const jsonMatch = responseText.match(/```(?:json|JSON)?\s*([\s\S]*?)\s*```/);
    let jsonStr = jsonMatch ? jsonMatch[1] : responseText;
    if (!jsonStr || jsonStr.trim()[0] !== '{') {
      const braceMatch = responseText.match(/\{[\s\S]*\}/);
      if (braceMatch) jsonStr = braceMatch[0];
    }
    geminiResult = JSON.parse(jsonStr || '{}');
  } catch {
    safeLog(env, 'warn', 'Gemini response parsing failed', {});
    throw new Error('Gemini response parsing failed');
  }

  const geminiAmount = typeof geminiResult.amount === 'number' ? geminiResult.amount : 0;
  const currencyFromText = detectCurrency(text);
  const currencyRaw = typeof geminiResult.currency === 'string' ? geminiResult.currency.trim().toUpperCase() : '';
  const currency = currencyRaw === 'JPY' || currencyRaw === 'USD' ? currencyRaw : currencyFromText;

  const VALID_DOC_TYPES = ['invoice', 'receipt', 'expense_report', 'other'] as const;
  const rawDocType = typeof geminiResult.document_type === 'string' ? geminiResult.document_type.toLowerCase() : 'other';
  const document_type = (VALID_DOC_TYPES as readonly string[]).includes(rawDocType)
    ? rawDocType as ClassificationResult['document_type']
    : 'other';

  const confidence = typeof geminiResult.confidence === 'number'
    ? Math.max(0, Math.min(1, geminiResult.confidence))
    : 0.7;

  // Respect explicit amount_extracted flag from Gemini (distinguishes "free" from "unreadable")
  const amountExtracted = typeof geminiResult.amount_extracted === 'boolean'
    ? geminiResult.amount_extracted
    : geminiAmount > 0;

  return {
    document_type,
    vendor_name: geminiResult.vendor_name || 'Unknown',
    amount: geminiAmount,
    currency,
    transaction_date: geminiResult.transaction_date || new Date().toISOString().split('T')[0],
    account_category: geminiResult.account_category,
    tax_type: geminiResult.tax_type,
    confidence,
    method: 'ai_assisted',
    cache_hit: false,
    amount_extracted: amountExtracted,
  };
}

// =============================================================================
// Main Classification Function
// =============================================================================

/**
 * Classify receipt with rule-based + AI fallback + caching
 */
export async function classifyReceipt(
  env: Env,
  text: string,
  metadata: Record<string, any> = {}
): Promise<ClassificationResult> {
  // Try rule-based classification first
  const ruleResult = tryRuleBasedClassification(text, metadata);
  if (ruleResult.matched && ruleResult.result) {
    safeLog(env, 'info', 'Rule-based classification succeeded', {
      vendor: ruleResult.result.vendor_name,
    });
    return {
      document_type: 'receipt',
      vendor_name: ruleResult.result.vendor_name ?? 'Unknown',
      amount: ruleResult.result.amount ?? 0,
      currency: detectCurrency(text),
      transaction_date: ruleResult.result.transaction_date ?? new Date().toISOString().split('T')[0],
      account_category: ruleResult.result.account_category,
      tax_type: undefined,
      department: undefined,
      confidence: ruleResult.result.confidence ?? 0.9,
      method: 'rule_based' as const,
      cache_hit: false,
      amount_extracted: ruleResult.result.amount_extracted ?? false,
    };
  }

  if (!env.KV) {
    // Degrade gracefully: still classify, just without caching.
    safeLog(env, 'warn', 'KV not configured; skipping classification cache', {});
    const result = await classifyWithAI(env, text, metadata);
    return result;
  }

  // Check cache for AI classification
  const tenant = getClassificationCacheTenant(metadata);
  const normalizedMetadata = normalizeClassificationMetadataForPrompt(metadata);
  // Cache key must be consistent with the model prompt inputs (minus volatile identifiers).
  const cacheKey = await calculateHash(`v2\n${tenant}\n${text}\n${JSON.stringify(normalizedMetadata)}`);
  let cached: string | null = null;
  try {
    cached = await env.KV.get(`classification:v2:${cacheKey}`);
  } catch (error) {
    // Cache is non-critical; degrade gracefully under KV quota/outage.
    safeLog(env, 'warn', 'Classification cache read failed (continuing)', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  if (cached) {
    try {
      const result = JSON.parse(cached);
      safeLog(env, 'info', 'Cache hit for classification', { cacheKey });
      return { ...result, cache_hit: true };
    } catch (parseError) {
      // Corrupted cache entry — treat as cache miss and continue to AI classification
      safeLog(env, 'warn', 'Classification cache corrupted, treating as miss', {
        cacheKey,
        error: parseError instanceof Error ? parseError.message : String(parseError),
      });
    }
  }

  // Stage 1: Workers AI classification
  safeLog(env, 'info', 'Calling Workers AI for classification', {});
  let result: ClassificationResult;
  try {
    result = await classifyWithAI(env, text, metadata);
  } catch (workersError) {
    safeLog(env, 'warn', 'Workers AI classification failed', {
      error: workersError instanceof Error ? workersError.message : String(workersError),
    });
    // Workers AI failed — skip to Gemini if available
    result = {
      document_type: 'other', vendor_name: 'Unknown', amount: 0, currency: 'JPY',
      transaction_date: new Date().toISOString().split('T')[0],
      confidence: 0, method: 'ai_assisted', cache_hit: false, amount_extracted: false,
    };
  }

  // Stage 2: Gemini escalation (if Workers AI result is low quality)
  if (shouldEscalateToGemini(result, env)) {
    safeLog(env, 'info', 'Escalating to Gemini API', {
      reason: !result.amount_extracted ? 'amount_missing' : 'low_confidence',
      workers_confidence: result.confidence,
      workers_amount: result.amount,
    });
    try {
      const geminiResult = await classifyWithGemini(env, text, metadata, result);
      // Merge: prefer Gemini result but keep Workers AI vendor if Gemini returned Unknown
      result = {
        ...geminiResult,
        vendor_name: geminiResult.vendor_name !== 'Unknown'
          ? geminiResult.vendor_name
          : result.vendor_name,
      };
    } catch (geminiError) {
      // Gemini failed — use best-effort Workers AI result
      safeLog(env, 'warn', 'Gemini escalation failed, using Workers AI result', {
        error: geminiError instanceof Error ? geminiError.message : String(geminiError),
      });
    }
  }

  // Cache final result for 30 days
  try {
    await env.KV.put(`classification:v2:${cacheKey}`, JSON.stringify(result), {
      expirationTtl: 30 * 24 * 60 * 60, // 30 days
    });
  } catch (error) {
    safeLog(env, 'warn', 'Classification cache write failed (continuing)', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return result;
}

// =============================================================================
// Batch Classification
// =============================================================================

/**
 * Classify multiple receipts in parallel
 */
export async function classifyBatch(
  env: Env,
  receipts: Array<{ text: string; metadata?: Record<string, any> }>
): Promise<ClassificationResult[]> {
  const promises = receipts.map((r) =>
    classifyReceipt(env, r.text, r.metadata || {})
  );
  return Promise.all(promises);
}

// =============================================================================
// Confidence Thresholds
// =============================================================================

/**
 * Check if confidence is sufficient for auto-submission
 */
export function isConfidentEnough(confidence: number): boolean {
  return confidence >= CONFIDENCE.MIN_AUTO;
}

/**
 * Check if manual review is required
 */
export function requiresManualReview(confidence: number): boolean {
  return confidence < CONFIDENCE.MIN_CREATE;
}
