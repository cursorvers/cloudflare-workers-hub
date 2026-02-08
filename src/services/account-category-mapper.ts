/**
 * Account Category Mapper
 *
 * Maps AI-classified categories to freee account_item_id and tax_code.
 */

// =============================================================================
// Types
// =============================================================================

export type MappingMethod = 'exact' | 'substring' | 'levenshtein' | 'fallback';

export interface MappingResult {
  accountItemId: number;
  taxCode: number;
  confidence: number;
  method: MappingMethod;
}

export interface AccountItemLike {
  id: number;
  name: string;
}

export interface TaxLike {
  id?: number;
  code?: number;
  name: string;
}

interface FuzzyMatch {
  item: AccountItemLike;
  confidence: number;
  method: MappingMethod;
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_TAX_NAME = '課税10%';
const NON_TAX_NAME = '非課税';

const NON_TAXABLE_KEYWORDS = ['非課税', '不課税', '免税', '対象外'];
const NON_TAXABLE_CATEGORIES = ['租税公課', '支払利息', '寄付金'];

const FALLBACK_PRIMARY = '雑費';
const FALLBACK_SECONDARY = 'その他';

// =============================================================================
// Helpers
// =============================================================================

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function toTaxCode(tax: TaxLike | null): number {
  if (!tax) {
    return 0;
  }
  return tax.code ?? tax.id ?? 0;
}

function findTaxByName(taxes: readonly TaxLike[], name: string): TaxLike | null {
  const normalized = normalize(name);
  return (
    taxes.find((tax) => normalize(tax.name) === normalized) ?? null
  );
}

function pickTaxCode(category: string, taxes: readonly TaxLike[]): number {
  const normalized = normalize(category);
  const isNonTaxable =
    NON_TAXABLE_KEYWORDS.some((keyword) => normalized.includes(normalize(keyword))) ||
    NON_TAXABLE_CATEGORIES.some((keyword) => normalized.includes(normalize(keyword)));

  const desired = isNonTaxable ? NON_TAX_NAME : DEFAULT_TAX_NAME;
  const match = findTaxByName(taxes, desired) ?? taxes[0] ?? null;
  return toTaxCode(match);
}

function pickFallbackAccountItem(
  accountItems: readonly AccountItemLike[]
): AccountItemLike | null {
  const primary = accountItems.find(
    (item) => normalize(item.name) === normalize(FALLBACK_PRIMARY)
  );
  if (primary) {
    return primary;
  }

  const secondary = accountItems.find((item) =>
    normalize(item.name).includes(normalize(FALLBACK_SECONDARY))
  );
  if (secondary) {
    return secondary;
  }

  return accountItems[0] ?? null;
}

function findExactMatch(
  category: string,
  accountItems: readonly AccountItemLike[]
): AccountItemLike | null {
  const normalized = normalize(category);
  return (
    accountItems.find((item) => normalize(item.name) === normalized) ?? null
  );
}

function findSubstringMatch(
  category: string,
  accountItems: readonly AccountItemLike[]
): FuzzyMatch | null {
  const normalized = normalize(category);
  const match = accountItems.find((item) => {
    const itemName = normalize(item.name);
    return itemName.includes(normalized) || normalized.includes(itemName);
  });

  if (!match) {
    return null;
  }

  const score = Math.min(
    normalize(match.name).length,
    normalized.length
  ) / Math.max(normalize(match.name).length, normalized.length || 1);

  return {
    item: match,
    confidence: Math.max(0.7, Math.min(0.9, score + 0.1)),
    method: 'substring',
  };
}

function levenshteinDistance(a: string, b: string): number {
  const aLength = a.length;
  const bLength = b.length;

  if (aLength === 0) {
    return bLength;
  }
  if (bLength === 0) {
    return aLength;
  }

  const matrix: number[][] = Array.from({ length: aLength + 1 }, () =>
    Array.from({ length: bLength + 1 }, () => 0)
  );

  for (let i = 0; i <= aLength; i += 1) {
    matrix[i][0] = i;
  }
  for (let j = 0; j <= bLength; j += 1) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= aLength; i += 1) {
    for (let j = 1; j <= bLength; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }

  return matrix[aLength][bLength];
}

function findLevenshteinMatch(
  category: string,
  accountItems: readonly AccountItemLike[]
): FuzzyMatch | null {
  const normalized = normalize(category);
  if (!normalized) {
    return null;
  }

  let best: FuzzyMatch | null = null;

  for (const item of accountItems) {
    const candidate = normalize(item.name);
    const distance = levenshteinDistance(normalized, candidate);
    const maxLength = Math.max(normalized.length, candidate.length, 1);
    const score = 1 - distance / maxLength;
    if (!best || score > best.confidence) {
      best = {
        item,
        confidence: score,
        method: 'levenshtein',
      };
    }
  }

  if (best && best.confidence >= 0.5) {
    return best;
  }

  return null;
}

function buildResult(
  accountItem: AccountItemLike,
  taxCode: number,
  method: MappingMethod,
  confidence: number
): MappingResult {
  return {
    accountItemId: accountItem.id,
    taxCode,
    confidence,
    method,
  };
}

// =============================================================================
// Public API
// =============================================================================

export function mapCategory(
  category: string,
  accountItems: readonly AccountItemLike[],
  taxes: readonly TaxLike[]
): MappingResult {
  const fallbackAccount = pickFallbackAccountItem(accountItems);
  const taxCode = pickTaxCode(category, taxes);

  if (!fallbackAccount) {
    return {
      accountItemId: 0,
      taxCode,
      confidence: 0.5,
      method: 'fallback',
    };
  }

  const exact = findExactMatch(category, accountItems);
  if (exact) {
    return buildResult(exact, taxCode, 'exact', 0.98);
  }

  const substring = findSubstringMatch(category, accountItems);
  if (substring) {
    return buildResult(
      substring.item,
      taxCode,
      substring.method,
      substring.confidence
    );
  }

  const levenshtein = findLevenshteinMatch(category, accountItems);
  if (levenshtein) {
    return buildResult(
      levenshtein.item,
      taxCode,
      levenshtein.method,
      Math.min(0.85, levenshtein.confidence)
    );
  }

  return buildResult(fallbackAccount, taxCode, 'fallback', 0.6);
}
