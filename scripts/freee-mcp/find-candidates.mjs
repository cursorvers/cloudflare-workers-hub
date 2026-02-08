#!/usr/bin/env node
/**
 * freee-mcp helper: filter a GET response JSON down to likely matches.
 *
 * Use-cases:
 * - "Not found" investigations: quickly narrow candidates without re-querying freee.
 * - Keep freee-mcp usage read-only.
 */

import fs from 'node:fs';

function usage(exitCode = 0) {
  const msg = `
Usage:
  node scripts/freee-mcp/find-candidates.mjs <jsonFile> [options]

Options:
  --array <field>          Use a specific top-level array field (e.g. deals/expenses/items).
  --id-field <field>       ID field name (default: auto: id/deal_id/expense_application_id/expense_id).
  --date-field <field>     Date field name (default: auto).
  --amount-field <field>   Amount field name (default: auto).
  --partner-field <field>  Partner ID field name (default: partner_id).

  --date <YYYY-MM-DD>      Match by date (normalizes ISO -> YYYY-MM-DD).
  --amount <number>        Match by amount (exact number compare after coercion).
  --partner <id>           Match by partner_id (string compare).
  --contains <text>        Case-insensitive substring match across common text fields.
  --field <k=v>            Exact match on arbitrary field (repeatable).
  --limit <n>              Max results to print (default: 50).
  --help                   Show help.

Examples:
  node scripts/freee-mcp/find-candidates.mjs candidates.json --date 2026-02-01 --amount 980 --contains "Amazon"
  node scripts/freee-mcp/find-candidates.mjs candidates.json --array deals --field status=approved
`.trim();
  process.stdout.write(msg + '\n');
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = {
    file: null,
    array: null,
    idField: null,
    dateField: null,
    amountField: null,
    partnerField: 'partner_id',
    date: null,
    amount: null,
    partner: null,
    contains: null,
    fieldEq: [],
    limit: 50,
  };

  const rest = [...argv];
  const first = rest.shift();
  if (!first || first === '--help' || first === '-h') usage(0);
  args.file = first;

  while (rest.length) {
    const t = rest.shift();
    if (t === '--help' || t === '-h') usage(0);
    if (t === '--array') args.array = rest.shift() ?? usage(2);
    else if (t === '--id-field') args.idField = rest.shift() ?? usage(2);
    else if (t === '--date-field') args.dateField = rest.shift() ?? usage(2);
    else if (t === '--amount-field') args.amountField = rest.shift() ?? usage(2);
    else if (t === '--partner-field') args.partnerField = rest.shift() ?? usage(2);
    else if (t === '--date') args.date = rest.shift() ?? usage(2);
    else if (t === '--amount') args.amount = rest.shift() ?? usage(2);
    else if (t === '--partner') args.partner = rest.shift() ?? usage(2);
    else if (t === '--contains') args.contains = rest.shift() ?? usage(2);
    else if (t === '--field') args.fieldEq.push(rest.shift() ?? usage(2));
    else if (t === '--limit') args.limit = Number(rest.shift() ?? usage(2));
    else usage(2);
  }
  return args;
}

function tryGetArray(obj, forcedField) {
  if (Array.isArray(obj)) return obj;
  if (!obj || typeof obj !== 'object') return null;

  if (forcedField) {
    const v = obj[forcedField];
    return Array.isArray(v) ? v : null;
  }

  for (const [, v] of Object.entries(obj)) {
    if (Array.isArray(v)) return v;
  }

  for (const k of ['data', 'result', 'results']) {
    const v = obj[k];
    if (Array.isArray(v)) return v;
    if (v && typeof v === 'object') {
      for (const [, vv] of Object.entries(v)) {
        if (Array.isArray(vv)) return vv;
      }
    }
  }
  return null;
}

function normalizeDate(v) {
  if (v === undefined || v === null) return null;
  const s = String(v);
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : s;
}

function coerceNumber(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function pickFirstExisting(item, fields) {
  for (const f of fields) {
    const v = item?.[f];
    if (v !== undefined && v !== null && v !== '') return f;
  }
  return null;
}

function pickId(item, forcedField) {
  if (forcedField) return item?.[forcedField] != null ? String(item[forcedField]) : '';
  for (const k of ['id', 'deal_id', 'expense_application_id', 'expense_id']) {
    const v = item?.[k];
    if (v !== undefined && v !== null && v !== '') return String(v);
  }
  return '';
}

function commonTextBlob(item) {
  const fields = [
    'description',
    'memo',
    'remarks',
    'note',
    'partner_name',
    'name',
    'title',
    'detail',
    'summary',
  ];
  const parts = [];
  for (const f of fields) {
    const v = item?.[f];
    if (typeof v === 'string' && v.trim()) parts.push(v.trim());
  }
  return parts.join(' | ');
}

const args = parseArgs(process.argv.slice(2));
const obj = JSON.parse(fs.readFileSync(args.file, 'utf8'));
const items = tryGetArray(obj, args.array);
if (!items) {
  process.stderr.write('Could not find an array in JSON. Try: --array <field>\n');
  process.exit(1);
}

// Auto-pick likely fields if not specified.
const sample = items.find((x) => x && typeof x === 'object') ?? {};
const dateField =
  args.dateField ??
  pickFirstExisting(sample, ['date', 'issue_date', 'accrual_date', 'payment_date', 'created_at', 'updated_at']);
const amountField =
  args.amountField ?? pickFirstExisting(sample, ['amount', 'total_amount', 'payment_amount', 'total', 'price']);

const filters = [];
if (args.date && dateField) {
  filters.push((it) => normalizeDate(it?.[dateField]) === args.date);
}
if (args.amount && amountField) {
  const want = coerceNumber(args.amount);
  filters.push((it) => coerceNumber(it?.[amountField]) === want);
}
if (args.partner) {
  const want = String(args.partner);
  filters.push((it) => String(it?.[args.partnerField] ?? '') === want);
}
if (args.contains) {
  const needle = String(args.contains).toLowerCase();
  filters.push((it) => commonTextBlob(it).toLowerCase().includes(needle));
}
for (const raw of args.fieldEq) {
  const idx = raw.indexOf('=');
  if (idx <= 0) {
    process.stderr.write(`Invalid --field "${raw}". Use k=v.\n`);
    process.exit(2);
  }
  const k = raw.slice(0, idx);
  const v = raw.slice(idx + 1);
  filters.push((it) => String(it?.[k] ?? '') === v);
}

const out = [];
for (const it of items) {
  if (!filters.every((f) => f(it))) continue;
  const id = pickId(it, args.idField);
  out.push({
    id,
    date: dateField ? normalizeDate(it?.[dateField]) : undefined,
    amount: amountField ? coerceNumber(it?.[amountField]) : undefined,
    partner_id: it?.[args.partnerField],
    text: commonTextBlob(it),
  });
}

const limited = out.slice(0, Number.isFinite(args.limit) ? args.limit : 50);
process.stdout.write(
  JSON.stringify(
    {
      total: out.length,
      dateField,
      amountField,
      partnerField: args.partnerField,
      results: limited,
    },
    null,
    2,
  ) + '\n',
);

