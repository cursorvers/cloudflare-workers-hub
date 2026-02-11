export type QuerySafety = 'SAFE' | 'SUSPICIOUS' | 'BLOCKED';

export interface QueryGuardResult {
  readonly safety: QuerySafety;
  readonly allowed: boolean;
  readonly detectedPatterns: readonly string[];
  readonly reason: string;
}

export interface QueryGuardConfig {
  readonly blockSuspicious: boolean; // default true
  readonly maxQueryLength: number; // default 10000
}

export const DEFAULT_QUERY_GUARD_CONFIG: QueryGuardConfig = Object.freeze({
  blockSuspicious: true,
  maxQueryLength: 10000,
});

const BLOCKING_PATTERNS = Object.freeze(
  new Set([
    'STRING_CONCAT',
    'TEMPLATE_INTERPOLATION',
    'UNION_SELECT',
    'DROP_TABLE',
    'MULTI_STATEMENT',
    'OR_TRUE_CONDITION',
  ]),
);

const PATTERN_DEFINITIONS = Object.freeze([
  Object.freeze({ name: 'STRING_CONCAT', regex: /(['"`])\s*\+\s*[^\s]/ }),
  Object.freeze({ name: 'TEMPLATE_INTERPOLATION', regex: /\$\{[^}]+\}/ }),
  Object.freeze({ name: 'UNION_SELECT', regex: /\bunion\b[\s\S]*\bselect\b/i }),
  Object.freeze({ name: 'DROP_TABLE', regex: /\bdrop\b\s+table\b/i }),
  Object.freeze({ name: 'SQL_COMMENT_INLINE', regex: /--/ }),
  Object.freeze({ name: 'SQL_COMMENT_BLOCK', regex: /\/\*/ }),
  Object.freeze({ name: 'MULTI_STATEMENT', regex: /;\s*\S/ }),
  Object.freeze({ name: 'OR_TRUE_CONDITION', regex: /\bor\b\s+1\s*=\s*1\b/i }),
] as const);

function freezePatterns(patterns: readonly string[]): readonly string[] {
  return Object.freeze([...patterns]);
}

function freezeResult(result: QueryGuardResult): QueryGuardResult {
  return Object.freeze({
    ...result,
    detectedPatterns: freezePatterns(result.detectedPatterns),
  });
}

function normalizeConfig(config?: QueryGuardConfig): QueryGuardConfig | null {
  if (config == null) {
    return DEFAULT_QUERY_GUARD_CONFIG;
  }

  if (
    typeof config.blockSuspicious !== 'boolean' ||
    !Number.isInteger(config.maxQueryLength) ||
    config.maxQueryLength <= 0
  ) {
    return null;
  }

  return Object.freeze({
    blockSuspicious: config.blockSuspicious,
    maxQueryLength: config.maxQueryLength,
  });
}

function countPlaceholders(query: string): number {
  const matches = query.match(/\?/g);
  return matches ? matches.length : 0;
}

// Detect dangerous SQL patterns.
export function detectDangerousPatterns(query: string): readonly string[] {
  if (typeof query !== 'string') {
    return freezePatterns(['INVALID_QUERY_TYPE']);
  }

  const detected = new Set<string>();
  for (const definition of PATTERN_DEFINITIONS) {
    if (definition.regex.test(query)) {
      detected.add(definition.name);
    }
  }
  return freezePatterns([...detected]);
}

// SQL query safety check. Fail-closed on invalid inputs.
export function checkQuery(
  query: string,
  params: readonly unknown[],
  config?: QueryGuardConfig,
): QueryGuardResult {
  try {
    const resolvedConfig = normalizeConfig(config);
    if (resolvedConfig == null) {
      return freezeResult({
        safety: 'BLOCKED',
        allowed: false,
        detectedPatterns: ['INVALID_CONFIG'],
        reason: 'fail-closed: invalid config',
      });
    }

    if (typeof query !== 'string') {
      return freezeResult({
        safety: 'BLOCKED',
        allowed: false,
        detectedPatterns: ['INVALID_QUERY_TYPE'],
        reason: 'fail-closed: query must be string',
      });
    }

    if (!Array.isArray(params)) {
      return freezeResult({
        safety: 'BLOCKED',
        allowed: false,
        detectedPatterns: ['INVALID_PARAMS_TYPE'],
        reason: 'fail-closed: params must be array',
      });
    }

    const trimmed = query.trim();
    if (trimmed.length === 0) {
      return freezeResult({
        safety: 'BLOCKED',
        allowed: false,
        detectedPatterns: ['EMPTY_QUERY'],
        reason: 'fail-closed: empty query',
      });
    }

    if (trimmed.length > resolvedConfig.maxQueryLength) {
      return freezeResult({
        safety: 'BLOCKED',
        allowed: false,
        detectedPatterns: ['QUERY_TOO_LONG'],
        reason: `fail-closed: query exceeds max length (${resolvedConfig.maxQueryLength})`,
      });
    }

    const detected = new Set(detectDangerousPatterns(trimmed));
    const placeholderCount = countPlaceholders(trimmed);

    if (placeholderCount === 0) {
      detected.add('MISSING_PLACEHOLDER');
    }
    if (placeholderCount !== params.length) {
      detected.add('PLACEHOLDER_PARAM_MISMATCH');
    }

    const detectedPatterns = freezePatterns([...detected]);
    const hasBlockingPattern = [...detected].some((pattern) =>
      BLOCKING_PATTERNS.has(pattern),
    );

    if (hasBlockingPattern || detected.has('MISSING_PLACEHOLDER') || detected.has('PLACEHOLDER_PARAM_MISMATCH')) {
      return freezeResult({
        safety: 'BLOCKED',
        allowed: false,
        detectedPatterns,
        reason: 'blocked: detected dangerous pattern or invalid prepared statement',
      });
    }

    if (detectedPatterns.length > 0) {
      const allowed = !resolvedConfig.blockSuspicious;
      return freezeResult({
        safety: 'SUSPICIOUS',
        allowed,
        detectedPatterns,
        reason: allowed
          ? 'suspicious: allowed by config override'
          : 'suspicious: blocked by default policy',
      });
    }

    return freezeResult({
      safety: 'SAFE',
      allowed: true,
      detectedPatterns,
      reason: 'safe: prepared statement enforced',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    return freezeResult({
      safety: 'BLOCKED',
      allowed: false,
      detectedPatterns: ['INTERNAL_ERROR'],
      reason: `fail-closed: internal error (${message})`,
    });
  }
}
