#!/usr/bin/env node
/**
 * freee-mcp helper: group candidate records into "possible duplicates".
 *
 * Purpose:
 * - Keep freee-mcp usage read-only.
 * - Turn a large GET response into a stable list of IDs to confirm one-by-one.
 *
 * This script intentionally makes minimal assumptions about the freee API response shape.
 */

import fs from 'node:fs';
import path from 'node:path';

function usage(exitCode = 0) {
  const msg = `
Usage:
  node scripts/freee-mcp/group-duplicates.mjs <jsonFile> [--key <expr>] [--array <field>] [--out <file>]

Examples:
  node scripts/freee-mcp/group-duplicates.mjs logs/freee-mcp/.../30_results/candidates.json
  node scripts/freee-mcp/group-duplicates.mjs candidates.json --key "date|amount|partner_id"
  node scripts/freee-mcp/group-duplicates.mjs candidates.json --array deals --key "issue_date|total_amount|partner_id"

Options:
  --array <field>  Use a specific top-level array field (e.g. deals/expenses/items).
  --key <expr>     Pipe-separated field list used to group (default: "date|amount|partner_id").
                  Fields are looked up in each item; missing fields become "_".
  --out <file>     Write grouped output JSON to a file (default: print summary to stdout only).
  --help           Show help.
`.trim();
  process.stdout.write(msg + '\n');
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = { file: null, array: null, keyExpr: null, out: null };
  const rest = [...argv];
  const first = rest.shift();
  if (!first || first === '--help' || first === '-h') usage(0);
  args.file = first;

  while (rest.length) {
    const t = rest.shift();
    if (t === '--help' || t === '-h') usage(0);
    if (t === '--array') args.array = rest.shift() ?? usage(2);
    else if (t === '--key') args.keyExpr = rest.shift() ?? usage(2);
    else if (t === '--out') args.out = rest.shift() ?? usage(2);
    else usage(2);
  }
  return args;
}

function pickFirstExistingField(sample, fields) {
  if (!sample || typeof sample !== 'object') return null;
  for (const f of fields) {
    const v = sample[f];
    if (v !== undefined && v !== null && v !== '') return f;
  }
  return null;
}

function autoKeyFields(items) {
  const sample = items.find((x) => x && typeof x === 'object') ?? {};
  const dateField = pickFirstExistingField(sample, [
    'date',
    'issue_date',
    'accrual_date',
    'payment_date',
    'created_at',
    'updated_at',
  ]);
  const amountField = pickFirstExistingField(sample, [
    'amount',
    'total_amount',
    'payment_amount',
    'total',
    'price',
  ]);
  const partnerField =
    pickFirstExistingField(sample, ['partner_id', 'partner_code', 'partner_name', 'partner']) ?? 'partner_id';

  return [dateField, amountField, partnerField].filter(Boolean);
}

function tryGetArray(obj, forcedField) {
  if (Array.isArray(obj)) return obj;
  if (!obj || typeof obj !== 'object') return null;

  if (forcedField) {
    const v = obj[forcedField];
    return Array.isArray(v) ? v : null;
  }

  // Heuristic: return the first top-level array we find.
  for (const [k, v] of Object.entries(obj)) {
    if (Array.isArray(v)) return v;
  }

  // Common nested patterns.
  for (const k of ['data', 'result', 'results']) {
    const v = obj[k];
    if (Array.isArray(v)) return v;
    if (v && typeof v === 'object') {
      for (const [kk, vv] of Object.entries(v)) {
        if (Array.isArray(vv)) return vv;
      }
    }
  }

  return null;
}

function getField(item, field) {
  if (!item || typeof item !== 'object') return '_';
  const v = item[field];
  if (v === undefined || v === null || v === '') return '_';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
  // For objects/arrays, keep it stable but compact.
  try {
    return JSON.stringify(v);
  } catch {
    return '_';
  }
}

function normalizeDate(s) {
  if (typeof s !== 'string') return s;
  // If it's an ISO string, reduce to YYYY-MM-DD for grouping stability.
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : s;
}

function buildGroupKey(item, fields) {
  const parts = fields.map((f) => {
    const raw = getField(item, f);
    return f.toLowerCase().includes('date') ? normalizeDate(raw) : raw;
  });
  return parts.join('|');
}

function pickId(item) {
  // Common ID field names; fall back to empty string.
  for (const k of ['id', 'deal_id', 'expense_application_id', 'expense_id']) {
    const v = item?.[k];
    if (v !== undefined && v !== null && v !== '') return String(v);
  }
  return '';
}

function summarize(groups) {
  const dupGroups = [...groups.values()].filter((g) => g.items.length >= 2);
  dupGroups.sort((a, b) => b.items.length - a.items.length);

  const summary = {
    totalGroups: groups.size,
    duplicateGroups: dupGroups.length,
    largestGroupSize: dupGroups[0]?.items.length ?? 0,
    top: dupGroups.slice(0, 20).map((g) => ({
      key: g.key,
      count: g.items.length,
      ids: g.items.map((it) => it._id).filter(Boolean).slice(0, 20),
    })),
  };
  return { summary, dupGroups };
}

const { file, array, keyExpr, out } = parseArgs(process.argv.slice(2));
const raw = fs.readFileSync(file, 'utf8');
const obj = JSON.parse(raw);
const items = tryGetArray(obj, array);
if (!items) {
  process.stderr.write(
    `Could not find an array in JSON. Try: --array <field> (top-level field name).\n`,
  );
  process.exit(1);
}

const fields = keyExpr
  ? keyExpr.split('|').map((s) => s.trim()).filter(Boolean)
  : autoKeyFields(items);
if (!fields.length) usage(2);

const groups = new Map();
for (const item of items) {
  const key = buildGroupKey(item, fields);
  const entry = groups.get(key) ?? { key, items: [] };
  entry.items.push({ _id: pickId(item), item });
  groups.set(key, entry);
}

const { summary, dupGroups } = summarize(groups);
process.stdout.write(JSON.stringify({ key_fields: fields, ...summary }, null, 2) + '\n');

if (out) {
  const outPath = path.resolve(out);
  const payload = {
    generated_at: new Date().toISOString(),
    key_fields: fields,
    duplicate_groups: dupGroups.map((g) => ({
      key: g.key,
      count: g.items.length,
      ids: g.items.map((it) => it._id).filter(Boolean),
      sample: g.items.slice(0, 3).map((it) => it.item),
    })),
  };
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
  process.stderr.write(`Wrote ${dupGroups.length} duplicate groups to: ${outPath}\n`);
}
