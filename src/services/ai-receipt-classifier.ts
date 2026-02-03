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
}

interface RuleBasedResult {
  matched: boolean;
  result?: Partial<ClassificationResult>;
}

// =============================================================================
// Rule-Based Classification (Primary)
// =============================================================================

/**
 * Attempt rule-based classification first
 * Rules are defined based on known vendors/patterns
 */
function tryRuleBasedClassification(
  text: string,
  metadata: Record<string, any>
): RuleBasedResult {
  // Example rules (expand based on business needs)
  const rules = [
    {
      pattern: /amazon|アマゾン/i,
      vendor_name: 'Amazon.co.jp',
      account_category: '消耗品費',
      confidence: 0.95,
    },
    {
      pattern: /google|グーグル/i,
      vendor_name: 'Google LLC',
      account_category: '広告宣伝費',
      confidence: 0.95,
    },
    {
      pattern: /cloudflare/i,
      vendor_name: 'Cloudflare Inc.',
      account_category: '通信費',
      confidence: 0.95,
    },
    {
      pattern: /stripe/i,
      vendor_name: 'Stripe Inc.',
      account_category: '支払手数料',
      confidence: 0.95,
    },
  ];

  for (const rule of rules) {
    if (rule.pattern.test(text)) {
      return {
        matched: true,
        result: {
          vendor_name: rule.vendor_name,
          account_category: rule.account_category,
          confidence: rule.confidence,
          method: 'rule_based',
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

/**
 * Call Workers AI for classification
 */
async function classifyWithAI(
  env: Env,
  text: string,
  metadata: Record<string, any>
): Promise<ClassificationResult> {
  const prompt = `Analyze this receipt/invoice and extract structured information.

Receipt Text:
${text}

Metadata:
${JSON.stringify(metadata, null, 2)}

Extract and return ONLY a JSON object with the following structure:
{
  "document_type": "invoice" | "receipt" | "expense_report" | "other",
  "vendor_name": "exact vendor name",
  "amount": number (in yen, no comma),
  "currency": "JPY",
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
    // Extract JSON from markdown code blocks if present
    const jsonMatch = response.response?.match(/```json\n([\s\S]*?)\n```/);
    const jsonStr = jsonMatch ? jsonMatch[1] : response.response;
    aiResult = JSON.parse(jsonStr || '{}');
  } catch (error) {
    safeLog(env, 'error', 'AI response parsing failed', {
      response,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    throw new Error('AI response parsing failed');
  }

  return {
    document_type: aiResult.document_type || 'other',
    vendor_name: aiResult.vendor_name || 'Unknown',
    amount: aiResult.amount || 0,
    currency: aiResult.currency || 'JPY',
    transaction_date: aiResult.transaction_date || new Date().toISOString().split('T')[0],
    account_category: aiResult.account_category,
    tax_type: aiResult.tax_type,
    confidence: aiResult.confidence || 0.5,
    method: 'ai_assisted',
    cache_hit: false,
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
      ...ruleResult.result,
      cache_hit: false,
    } as ClassificationResult;
  }

  // Check cache for AI classification
  const cacheKey = await calculateHash(text + JSON.stringify(metadata));
  const cached = await env.KV.get(`classification:${cacheKey}`);
  if (cached) {
    safeLog(env, 'info', 'Cache hit for classification', { cacheKey });
    const result = JSON.parse(cached);
    return { ...result, cache_hit: true };
  }

  // Fallback to AI classification
  safeLog(env, 'info', 'Calling Workers AI for classification', {});
  const result = await classifyWithAI(env, text, metadata);

  // Cache result for 30 days
  await env.KV.put(`classification:${cacheKey}`, JSON.stringify(result), {
    expirationTtl: 30 * 24 * 60 * 60, // 30 days
  });

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
  return confidence >= 0.8;
}

/**
 * Check if manual review is required
 */
export function requiresManualReview(confidence: number): boolean {
  return confidence < 0.5;
}
