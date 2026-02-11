import { describe, expect, it } from 'vitest';

import {
  checkQuery,
  DEFAULT_QUERY_GUARD_CONFIG,
  detectDangerousPatterns,
} from '../query-guard';

describe('runtime/query-guard', () => {
  it('パラメータ化クエリ（SELECT ... WHERE id = ?）でSAFE', () => {
    const result = checkQuery('SELECT * FROM users WHERE id = ?', [123]);

    expect(result.safety).toBe('SAFE');
    expect(result.allowed).toBe(true);
    expect(result.detectedPatterns).toEqual([]);
  });

  it('文字列連結検出でBLOCKED', () => {
    const result = checkQuery("SELECT * FROM users WHERE id = ' + userId", []);

    expect(result.safety).toBe('BLOCKED');
    expect(result.allowed).toBe(false);
    expect(result.detectedPatterns).toContain('STRING_CONCAT');
  });

  it('UNION SELECT検出でBLOCKED', () => {
    const result = checkQuery(
      'SELECT * FROM users WHERE id = ? UNION SELECT password FROM users',
      [1],
    );

    expect(result.safety).toBe('BLOCKED');
    expect(result.allowed).toBe(false);
    expect(result.detectedPatterns).toContain('UNION_SELECT');
  });

  it('DROP TABLE検出でBLOCKED', () => {
    const result = checkQuery('SELECT * FROM users WHERE id = ?; DROP TABLE users', [1]);

    expect(result.safety).toBe('BLOCKED');
    expect(result.allowed).toBe(false);
    expect(result.detectedPatterns).toContain('DROP_TABLE');
  });

  it('SQLコメント（--）検出でSUSPICIOUS', () => {
    const result = checkQuery('SELECT * FROM users WHERE id = ? -- injected', [1], {
      ...DEFAULT_QUERY_GUARD_CONFIG,
      blockSuspicious: false,
    });

    expect(result.safety).toBe('SUSPICIOUS');
    expect(result.detectedPatterns).toContain('SQL_COMMENT_INLINE');
  });

  it('空クエリでBLOCKED（fail-closed）', () => {
    const result = checkQuery('   ', []);

    expect(result.safety).toBe('BLOCKED');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('fail-closed');
  });

  it('maxQueryLength超過でBLOCKED', () => {
    const longQuery = `SELECT * FROM users WHERE id = ? ${'x'.repeat(40)}`;
    const result = checkQuery(longQuery, [1], {
      ...DEFAULT_QUERY_GUARD_CONFIG,
      maxQueryLength: 20,
    });

    expect(result.safety).toBe('BLOCKED');
    expect(result.allowed).toBe(false);
    expect(result.detectedPatterns).toContain('QUERY_TOO_LONG');
  });

  it('全結果がObject.freeze', () => {
    const safe = checkQuery('SELECT * FROM users WHERE id = ?', [1]);
    const suspicious = checkQuery('SELECT * FROM users WHERE id = ? -- note', [1], {
      ...DEFAULT_QUERY_GUARD_CONFIG,
      blockSuspicious: false,
    });
    const blocked = checkQuery('   ', []);
    const patterns = detectDangerousPatterns('SELECT * FROM users -- x');

    expect(Object.isFrozen(DEFAULT_QUERY_GUARD_CONFIG)).toBe(true);
    expect(Object.isFrozen(safe)).toBe(true);
    expect(Object.isFrozen(safe.detectedPatterns)).toBe(true);
    expect(Object.isFrozen(suspicious)).toBe(true);
    expect(Object.isFrozen(blocked)).toBe(true);
    expect(Object.isFrozen(patterns)).toBe(true);
  });
});
