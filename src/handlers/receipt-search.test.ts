import { describe, expect, it } from 'vitest';

import { handleReceiptDetail, handleReceiptFileDownload } from './receipt-search';

function makeEnv(overrides: any = {}) {
  const db = {
    prepare: (sql: string) => {
      const state = (db as any)._state as any;

      return {
        bind: (..._args: any[]) => {
          return {
            first: async () => {
              if (sql.includes('SELECT * FROM receipts')) return state.receipt ?? null;
              if (sql.includes('SELECT id, r2_object_key FROM receipts')) return state.receiptMinimal ?? null;
              if (sql.includes('SELECT COUNT(*)')) return { total: 0 };
              return null;
            },
            all: async () => {
              if (sql.includes('SELECT * FROM audit_logs')) {
                return { results: state.auditTrail ?? [] };
              }
              return { results: [] };
            },
            run: async () => ({ success: true }),
          };
        },
      };
    },
    _state: {
      receipt: null,
      receiptMinimal: null,
      auditTrail: [],
    },
  };

  const env: any = {
    DB: db,
    RECEIPTS: undefined,
    R2: undefined,
    ...overrides,
  };

  return env;
}

function makeBucket({ headOk = true, getOk = true }: { headOk?: boolean; getOk?: boolean }) {
  return {
    head: async (_key: string) =>
      headOk
        ? ({
            size: 123,
            writeHttpMetadata: (h: Headers) => {
              h.set('Content-Type', 'application/pdf');
            },
          } as any)
        : null,
    get: async (_key: string) => {
      if (!getOk) return null;
      return {
        body: 'file-bytes',
        writeHttpMetadata: (_h: Headers) => {
          _h.set('Content-Type', 'application/pdf');
        },
      } as any;
    },
  } as any;
}

describe('receipt-search handleReceiptDetail', () => {
  it('returns has_file=true and file_url when R2 object exists', async () => {
    const env = makeEnv();
    (env.DB as any)._state.receipt = { id: 'r1', r2_object_key: 'receipts/t/r1/a.pdf', file_hash: 'sha256' };
    (env.DB as any)._state.auditTrail = [{ id: 1 }];
    env.RECEIPTS = makeBucket({ headOk: true });

    const req = new Request('https://example.com/api/receipts/r1');
    const res = await handleReceiptDetail(req, env, 'r1');
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.has_file).toBe(true);
    expect(String(json.file_url)).toBe('https://example.com/api/receipts/r1/file');
  });

  it('returns has_file=false and file_url=null when R2 object is missing', async () => {
    const env = makeEnv();
    (env.DB as any)._state.receipt = { id: 'r2', r2_object_key: 'receipts/t/r2/a.pdf', file_hash: 'sha256' };
    env.RECEIPTS = makeBucket({ headOk: false });

    const req = new Request('https://example.com/api/receipts/r2');
    const res = await handleReceiptDetail(req, env, 'r2');
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.has_file).toBe(false);
    expect(json.file_url).toBe(null);
  });
});

describe('receipt-search handleReceiptFileDownload', () => {
  it('returns 404 when receipt row missing', async () => {
    const env = makeEnv();
    (env.DB as any)._state.receiptMinimal = null;
    env.RECEIPTS = makeBucket({ getOk: true });

    const req = new Request('https://example.com/api/receipts/r3/file');
    const res = await handleReceiptFileDownload(req, env, 'r3');
    expect(res.status).toBe(404);
  });

  it('streams file when present', async () => {
    const env = makeEnv();
    (env.DB as any)._state.receiptMinimal = { id: 'r4', r2_object_key: 'receipts/t/r4/a.pdf' };
    env.RECEIPTS = makeBucket({ getOk: true });

    const req = new Request('https://example.com/api/receipts/r4/file');
    const res = await handleReceiptFileDownload(req, env, 'r4');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition') || '').toContain('attachment;');
  });

  it('returns headers only on HEAD when present', async () => {
    const env = makeEnv();
    (env.DB as any)._state.receiptMinimal = { id: 'r5', r2_object_key: 'receipts/t/r5/a.pdf' };
    env.RECEIPTS = makeBucket({ headOk: true, getOk: true });

    const req = new Request('https://example.com/api/receipts/r5/file', { method: 'HEAD' });
    const res = await handleReceiptFileDownload(req, env, 'r5');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition') || '').toContain('attachment;');

    const body = await res.text();
    expect(body).toBe('');
  });
});
