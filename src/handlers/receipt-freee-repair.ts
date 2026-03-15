import type { Env } from '../types';
import { safeLog } from '../utils/log-sanitizer';
import { createFreeeClient } from '../services/freee-client';

type FreeeReceiptLite = { id: number; deal_id?: number };

export type LinkableFreeeClient = {
  getReceipt: (receiptId: number) => Promise<FreeeReceiptLite>;
  linkReceiptToDeal: (receiptId: number, dealId: number) => Promise<void>;
};

function toPositiveInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number.parseInt(value, 10);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return null;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function handleRepairFreeeLinks(
  request: Request,
  env: Env,
  tenantId: string,
  clientOverride?: LinkableFreeeClient
): Promise<Response> {
  if (!env.DB) {
    return json({ error: 'DB not configured' }, 503);
  }

  const url = new URL(request.url);
  const limitRaw = url.searchParams.get('limit') ?? '20';
  const limit = Math.max(1, Math.min(100, Number.parseInt(limitRaw, 10) || 20));
  const dry_run = (url.searchParams.get('dry_run') ?? 'true') !== 'false';

  const rows = await env.DB.prepare(
    `SELECT id, freee_receipt_id, freee_deal_id
     FROM receipts
     WHERE tenant_id = ? AND freee_receipt_id IS NOT NULL AND freee_deal_id IS NOT NULL
     ORDER BY created_at DESC
     LIMIT ?`
  )
    .bind(tenantId, limit)
    .all<{
      id: string;
      freee_receipt_id: string | number | null;
      freee_deal_id: string | number | null;
    }>();

  const client: LinkableFreeeClient =
    clientOverride ?? (createFreeeClient(env, { tenantId }) as unknown as LinkableFreeeClient);

  let scanned = 0;
  let ok = 0;
  let repaired = 0;
  let would_repair = 0;
  let conflicts = 0;
  let skipped = 0;
  let errors = 0;

  const results: Array<{
    id: string;
    freee_receipt_id: string | number | null;
    freee_deal_id: string | number | null;
    action: 'ok' | 'repaired' | 'would_repair' | 'conflict' | 'skipped' | 'error';
    note?: string;
  }> = [];

  for (const row of rows.results ?? []) {
    scanned += 1;

    const freeeReceiptId = toPositiveInt(row.freee_receipt_id);
    const freeeDealId = toPositiveInt(row.freee_deal_id);
    if (!freeeReceiptId || !freeeDealId) {
      skipped += 1;
      results.push({
        id: row.id,
        freee_receipt_id: row.freee_receipt_id,
        freee_deal_id: row.freee_deal_id,
        action: 'skipped',
        note: 'invalid freee_receipt_id or freee_deal_id',
      });
      continue;
    }

    try {
      const receipt = await client.getReceipt(freeeReceiptId);
      const dealIdOnFreee = toPositiveInt((receipt as any).deal_id);

      if (dealIdOnFreee === freeeDealId) {
        ok += 1;
        results.push({
          id: row.id,
          freee_receipt_id: row.freee_receipt_id,
          freee_deal_id: row.freee_deal_id,
          action: 'ok',
        });
        continue;
      }

      if (!dealIdOnFreee) {
        if (dry_run) {
          would_repair += 1;
          results.push({
            id: row.id,
            freee_receipt_id: row.freee_receipt_id,
            freee_deal_id: row.freee_deal_id,
            action: 'would_repair',
          });
          continue;
        }

        await client.linkReceiptToDeal(freeeReceiptId, freeeDealId);
        repaired += 1;
        results.push({
          id: row.id,
          freee_receipt_id: row.freee_receipt_id,
          freee_deal_id: row.freee_deal_id,
          action: 'repaired',
        });
        continue;
      }

      conflicts += 1;
      results.push({
        id: row.id,
        freee_receipt_id: row.freee_receipt_id,
        freee_deal_id: row.freee_deal_id,
        action: 'conflict',
        note: `freee receipt already linked to different deal_id=${dealIdOnFreee}`,
      });
    } catch (error) {
      errors += 1;
      safeLog(env, 'warn', '[RepairFreeeLinks] failed to verify/repair', {
        receiptId: row.id,
        freeeReceiptId,
        freeeDealId,
        error: error instanceof Error ? error.message : String(error),
      });
      results.push({
        id: row.id,
        freee_receipt_id: row.freee_receipt_id,
        freee_deal_id: row.freee_deal_id,
        action: 'error',
        note: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return json({
    success: true,
    dry_run,
    scanned,
    ok,
    repaired,
    would_repair,
    conflicts,
    skipped,
    errors,
    results,
  });
}
